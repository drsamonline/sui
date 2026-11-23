import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FIXTURES, PROBE_FIXTURE_VERSION, Prober, probeTarget } from '@drsamonline/prober';
import { normalizeEntry } from '@drsamonline/catalog';

/**
 * A fake OpenAI-compatible upstream whose behaviour each test can bend:
 * health, streaming shape, JSON compliance, tool acceptance.
 */
async function startFake(opts = {}) {
  const behaviour = {
    livenessStatus: 200,
    readiness: 'ok', // 'ok' | 'empty' | '500'
    streaming: 'real', // 'real' | 'blob' | 'none'
    json: 'ok', // 'ok' | 'prose'
    tools: 'ok', // 'ok' | 'reject'
    ...opts,
  };
  let calls = 0;

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls += 1;

    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(behaviour.livenessStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }

    if (behaviour.readiness === '500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }

    if (body.stream) {
      if (behaviour.streaming === 'blob') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{}}]}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
      for (const word of ['rea', 'dy']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (body.tools && behaviour.tools === 'reject') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tools unsupported' } }));
      return;
    }

    const wantsJson = body.response_format?.type === 'json_object';
    const content = behaviour.readiness === 'empty' ? '' : wantsJson && behaviour.json === 'prose' ? 'Sure! Here is JSON.' : wantsJson ? '{"ok":true}' : 'ready';

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    );
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    behaviour,
    get calls() {
      return calls;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const entryFor = (url, capabilities = ['chat', 'streaming']) =>
  normalizeEntry({ provider: 'fake', base_url: url, model_family: 'fake-model', capabilities, needs_probe: true });

test('fixtures are versioned, synthetic and side-effect free', () => {
  assert.match(PROBE_FIXTURE_VERSION, /^\d+\.\d+\.\d+$/);
  const text = JSON.stringify(FIXTURES);
  for (const forbidden of ['@', 'password', 'secret', 'api key', 'INSERT', 'DELETE', 'DROP']) {
    assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false, `fixture must not contain "${forbidden}"`);
  }
  assert.equal(FIXTURES.tools.tools[0].function.description.includes('Read-only'), true);
});

test('a healthy upstream is verified, with all three levels recorded', async () => {
  const fake = await startFake();
  const result = await probeTarget(entryFor(fake.url), { allowLocal: true });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.levels.liveness.ok, true);
  assert.equal(result.levels.readiness.ok, true);
  assert.equal(result.levels.suitability.streaming.ok, true);
  assert.ok(result.latencyMs >= 0);
  assert.deepEqual(result.reasons, []);
  await fake.close();
});

test('an empty completion fails readiness, so the route is not verified', async () => {
  const fake = await startFake({ readiness: 'empty' });
  const result = await probeTarget(entryFor(fake.url), { allowLocal: true });
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.reasons.join(' '), /readiness: empty completion/);
  await fake.close();
});

test('a 500 fails readiness even though liveness passed', async () => {
  const fake = await startFake({ readiness: '500' });
  const result = await probeTarget(entryFor(fake.url), { allowLocal: true });
  assert.equal(result.levels.liveness.ok, true);
  assert.equal(result.levels.readiness.ok, false);
  assert.equal(result.ok, false);
  await fake.close();
});

test('suitability: one frame pretending to be a stream is caught', async () => {
  const fake = await startFake({ streaming: 'blob' });
  const result = await probeTarget(entryFor(fake.url), { allowLocal: true });
  assert.equal(result.levels.suitability.streaming.ok, false);
  assert.match(result.levels.suitability.streaming.note, /not a real stream/);
  assert.equal(result.ok, false, 'a claimed capability that does not work must fail the probe');
  await fake.close();
});

test('suitability: prose instead of JSON fails the json_schema check', async () => {
  const fake = await startFake({ json: 'prose' });
  const result = await probeTarget(entryFor(fake.url, ['chat', 'json_schema']), { allowLocal: true });
  assert.equal(result.levels.suitability.json_schema.ok, false);
  assert.match(result.levels.suitability.json_schema.note, /not JSON/);
  await fake.close();
});

test('suitability: a rejected tool schema is a failure, not a preference', async () => {
  const fake = await startFake({ tools: 'reject' });
  const result = await probeTarget(entryFor(fake.url, ['chat', 'tools']), { allowLocal: true });
  assert.equal(result.levels.suitability.tools.ok, false);
  assert.match(result.levels.suitability.tools.note, /tools rejected/);
  await fake.close();
});

test('capabilities it does not claim are not probed', async () => {
  const fake = await startFake();
  const result = await probeTarget(entryFor(fake.url, ['chat']), { allowLocal: true });
  assert.deepEqual(Object.keys(result.levels.suitability), []);
  assert.equal(result.ok, true);
  await fake.close();
});

test('an identity with no base_url is refused, not guessed', async () => {
  const entry = normalizeEntry({ provider: 'pollinations', auth: 'none' });
  const result = await probeTarget(entry);
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /no endpoint to probe/);
});

test('an unreachable host is reported as unreachable, not as a crash', async () => {
  const result = await probeTarget(entryFor('http://127.0.0.1:1/v1'), { timeoutMs: 500, allowLocal: true });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.reasons), /unreachable|timed out/);
});

test('an unreachable host is not asked twice: readiness is skipped, not retried', async () => {
  const t0 = Date.now();
  const result = await probeTarget(entryFor('http://127.0.0.1:1/v1'), { timeoutMs: 300, allowLocal: true });
  const elapsed = Date.now() - t0;

  assert.equal(result.levels.readiness.ok, false);
  assert.match(result.levels.readiness.note, /not attempted: endpoint unreachable/);
  assert.ok(elapsed < 900, `should fail fast, took ${elapsed}ms`);
  assert.ok(result.reasons.some((r) => /liveness:/.test(r)));
});

test('the prober disables a route after three consecutive failures', async () => {
  const fake = await startFake({ readiness: '500' });
  const prober = new Prober({ entries: [entryFor(fake.url)], failuresBeforeDisable: 3, allowLocal: true });

  await prober.runOnce();
  assert.equal(prober.snapshot()[0].status, 'degraded');
  await prober.runOnce();
  assert.equal(prober.snapshot()[0].status, 'degraded');
  await prober.runOnce();
  assert.equal(prober.snapshot()[0].status, 'disabled');
  assert.equal(prober.snapshot()[0].failures, 3);
  await fake.close();
});

test('and re-enables it the moment a probe succeeds', async () => {
  const fake = await startFake({ readiness: '500' });
  const prober = new Prober({ entries: [entryFor(fake.url)], failuresBeforeDisable: 2, allowLocal: true });
  await prober.runOnce();
  await prober.runOnce();
  assert.equal(prober.snapshot()[0].status, 'disabled');

  fake.behaviour.readiness = 'ok';
  await prober.runOnce();
  const state = prober.snapshot()[0];
  assert.equal(state.status, 'healthy');
  assert.equal(state.failures, 0, 'recovery resets the failure count');
  assert.ok(state.lastOkAt);
  await fake.close();
});

test('the probe map feeds catalogue scoring without a second format', async () => {
  const fake = await startFake();
  const prober = new Prober({ entries: [entryFor(fake.url)], allowLocal: true });
  await prober.runOnce();
  const map = prober.probeMap();
  const [key] = Object.keys(map);
  assert.equal(map[key].ok, true);
  assert.ok(map[key].checkedAt);
  await fake.close();
});

test('history is capped, so a long soak cannot grow it without bound', async () => {
  const fake = await startFake();
  const prober = new Prober({ entries: [entryFor(fake.url)], allowLocal: true });
  for (let i = 0; i < 30; i++) await prober.runOnce();
  const state = prober.state.get(prober.snapshot()[0].pool_key);
  assert.equal(state.history.length, 24);
  await fake.close();
});

test('start() schedules and stop() clears, without holding the process open', async () => {
  const fake = await startFake();
  const prober = new Prober({ entries: [entryFor(fake.url)], intervalMs: 50, allowLocal: true });
  prober.start();
  assert.ok(prober.timer);
  await new Promise((r) => setTimeout(r, 120));
  prober.stop();
  assert.equal(prober.timer, null);
  assert.ok(prober.runs >= 2, 'the schedule should have run more than once');
  await fake.close();
});

/* -------------------------------------------------- B10.1 the Weather Map */

test('the weather vocabulary is three words plus "not checked yet"', async () => {
  const { weatherLabel } = await import('@drsamonline/prober');
  assert.equal(weatherLabel('healthy'), 'thriving');
  assert.equal(weatherLabel('degraded'), 'resting');
  assert.equal(weatherLabel('disabled'), 'down');
  assert.equal(weatherLabel('unverified'), 'unverified', 'never checked is not the same as down');
});

test('the snapshot carries history and a weather word for the map', async () => {
  const fake = await startFake();
  const prober = new Prober({ entries: [entryFor(fake.url)], allowLocal: true });
  await prober.runOnce();
  await prober.runOnce();

  const row = prober.snapshot()[0];
  assert.equal(row.weather, 'thriving');
  assert.equal(row.history.length, 2, 'two observations for the trend line');
  assert.equal(row.history[0].ok, true);
  assert.ok(row.history[0].at);
  await fake.close();
});

test('a provider that fails reads as down, with the reason attached', async () => {
  const fake = await startFake({ readiness: '500' });
  const prober = new Prober({ entries: [entryFor(fake.url)], failuresBeforeDisable: 2, allowLocal: true });
  await prober.runOnce();
  await prober.runOnce();

  const row = prober.snapshot()[0];
  assert.equal(row.weather, 'down');
  assert.ok(row.reasons.length > 0);
  assert.equal(row.history.filter((h) => h.ok === false).length, 2);
  await fake.close();
});

/* ---------------------------------- the model is discovered, not assumed */

test('the readiness probe calls a model the endpoint actually listed', async () => {
  const { probeTarget } = await import('@drsamonline/prober');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/models')) {
      return new Response(
        JSON.stringify({ data: [{ id: 'text-embedding-3-small' }, { id: 'openai-fast' }, { id: 'whisper-1' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const entry = { provider: 'imported', base_url: 'https://example.test/v1', model_family: 'openai-compatible', auth: 'none', capabilities: ['chat'] };
  const result = await probeTarget(entry, { fetchImpl, timeoutMs: 1000 });

  const chat = seen.find((c) => c.url.endsWith('/chat/completions'));
  assert.equal(chat.body.model, 'openai-fast', 'an embedding or speech model is not a chat model');
  assert.equal(result.levels.liveness.models, 1, 'the embedding and speech models were filtered out');
});

test('a family name is never sent as a model', async () => {
  const { probeTarget } = await import('@drsamonline/prober');
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await probeTarget({ provider: 'x', base_url: 'https://example.test/v1', model_family: 'openai-compatible', auth: 'none' }, { fetchImpl, timeoutMs: 1000 });
  assert.notEqual(bodies[0].model, 'openai-compatible', 'a category is not a model id');
  assert.equal(bodies[0].model, 'default');
});

test('an explicit probe_model wins over discovery', async () => {
  const { probeTarget } = await import('@drsamonline/prober');
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'listed-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await probeTarget(
    { provider: 'x', base_url: 'https://example.test/v1', model_family: 'openai-compatible', probe_model: 'chosen-model', auth: 'none' },
    { fetchImpl, timeoutMs: 1000 },
  );
  assert.equal(bodies[0].model, 'chosen-model');
});

test('a probe never touches the user\'s own machine or cloud account', async () => {
  const { probeAddressAllowed } = await import('../packages/prober/src/index.js');

  // The catalogue is data, and data can name any address. Without this guard a
  // seeded or imported base_url of http://169.254.169.254/ would be fetched on
  // the user's machine and reported as a provider's health.
  const refused = [
    'http://169.254.169.254/latest/meta-data',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
    'https://10.0.0.5/v1',
    'https://192.168.1.1/v1',
    'https://172.16.0.9/v1',
    'https://db.internal/v1',
    'https://printer.local/v1',
    'http://api.groq.com/v1', // plain http, not loopback
    'ftp://example.com',
    'not a url',
  ];
  for (const url of refused) {
    assert.equal(probeAddressAllowed(url).ok, false, `${url} should not be probeable`);
  }

  // real providers are still probeable
  for (const url of ['https://api.groq.com/openai/v1', 'https://generativelanguage.googleapis.com/v1beta']) {
    assert.equal(probeAddressAllowed(url).ok, true, `${url} should be probeable`);
  }

  // and a loopback probe is possible when something asks for it explicitly
  assert.equal(probeAddressAllowed('http://127.0.0.1:11434/v1', { allowLocal: true }).ok, true);
});

test('a catalogue entry marked local may be probed on loopback; a remote one may not', async () => {
  const { probeTarget } = await import('../packages/prober/src/index.js');

  // ollama and LM Studio live on 127.0.0.1 and are marked local: true. Without
  // this, the SSRF guard disabled every local model server the moment it landed.
  const local = await probeTarget(
    { provider: 'ollama', base_url: 'http://127.0.0.1:1/v1', model_family: 'openai-compatible', capabilities: ['chat'], local: true },
    { timeoutMs: 300 },
  );
  assert.equal(
    local.reasons.some((r) => r.includes('refusing to probe')),
    false,
    'a local entry is allowed to reach loopback',
  );
  assert.match(local.reasons.join(' '), /unreachable|timed out/);

  // a remote entry that names loopback is not local, and is still refused
  const remote = await probeTarget(
    { provider: 'sketchy', base_url: 'http://127.0.0.1:6379/v1', model_family: 'openai-compatible', capabilities: ['chat'] },
    { timeoutMs: 300 },
  );
  assert.match(remote.reasons.join(' '), /refusing to probe/);
});

test('suitability is probed with the model that answered readiness', async () => {
  const { probeTarget } = await import('../packages/prober/src/index.js');
  const http = await import('node:http');

  // Groq answered readiness and then 404'd all three suitability checks, because they
  // asked for `modelFor(entry)` — a family name like "openai-compatible" — instead of
  // the model that had just proved it works. A working provider was recorded as
  // unsuitable, so no route was ever promoted.
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'tts-voice' }, { id: 'openai/gpt-oss-120b' }] }));
        return;
      }
      const parsed = JSON.parse(body || '{}');
      asked.push(parsed.model);
      if (parsed.model !== 'openai/gpt-oss-120b') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model not found' } }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const result = await probeTarget(
      {
        provider: 'groq',
        base_url: `http://127.0.0.1:${port}/v1`,
        model_family: 'openai-compatible',
        capabilities: ['chat', 'streaming'],
        local: true,
      },
      { timeoutMs: 5000 },
    );

    assert.equal(result.levels.readiness.ok, true, 'readiness must pass');
    // every request after discovery used the chat model, never the family name
    assert.equal(asked.includes('openai-compatible'), false, 'a family name was used as a model id');
    assert.equal(asked.includes('tts-voice'), false, 'a text-to-speech model was used as a chat model');
  } finally {
    server.close();
  }
});

test('a reasoning model that answers with reasoning is ready, not an empty completion', async () => {
  const { probeTarget } = await import('../packages/prober/src/index.js');
  const http = await import('node:http');

  // Groq's gpt-oss answered the probe with its thinking in `reasoning` and an empty
  // `content`, and the probe recorded "empty completion" — a working provider marked
  // unusable, so nothing was ever promoted to a route.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }] }));
        return;
      }
      const parsed = JSON.parse(body || '{}');
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'ready' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 12, completion_tokens: 40 },
      }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const result = await probeTarget(
      { provider: 'groq', base_url: `http://127.0.0.1:${port}/v1`, model_family: 'openai-compatible', capabilities: ['chat'], local: true },
      { timeoutMs: 5000 },
    );
    assert.equal(result.levels.readiness.ok, true, 'reasoning text is an answer');
    assert.equal(result.verified, true, 'and the entry is verified, so a route can be promoted');
  } finally {
    server.close();
  }
});

/* ------------------------------------------- a sweep is bounded, not a flood */

/**
 * 41 entries × an 8-second timeout is the sweep's worst case. Serial that is five
 * minutes; unbounded it is one burst of 41 handshakes from a single IP, which is
 * what a free tier answers with 429 — and a 429 was being recorded as "not
 * suitable", so a working provider got demoted for being asked too eagerly.
 */
function entriesFor(n) {
  return Array.from({ length: n }, (_, i) => ({
    provider: `p${String(i).padStart(2, '0')}`,
    base_url: `https://p${i}.example.invalid/v1`,
    models: ['m'],
    capabilities: ['chat'],
  }));
}

function countingFetch(delayMs, onTick = () => {}) {
  const state = { inFlight: 0, peak: 0 };
  const fetchImpl = async () => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    onTick(state.inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    state.inFlight -= 1;
    throw new Error('unreachable');
  };
  return { fetchImpl, state };
}

test('a sweep keeps at most `concurrency` entries in flight', async () => {
  const { fetchImpl, state } = countingFetch(40);
  const prober = new Prober({ entries: entriesFor(20), fetchImpl, timeoutMs: 500, concurrency: 4 });
  await prober.runOnce();
  assert.ok(state.peak <= 4, `peak in flight was ${state.peak}, above the bound of 4`);
  assert.ok(state.peak >= 2, 'the pool must actually overlap work, not fall back to serial');
});

test('concurrency 1 is the old one-at-a-time behaviour, for when a provider asks', async () => {
  const { fetchImpl, state } = countingFetch(5);
  const prober = new Prober({ entries: entriesFor(6), fetchImpl, timeoutMs: 500, concurrency: 1 });
  await prober.runOnce();
  assert.equal(state.peak, 1);
});

test('a bounded sweep is far faster than serial, and still reports every entry', async () => {
  const { fetchImpl } = countingFetch(50);
  const entries = entriesFor(20);
  const started = Date.now();
  const prober = new Prober({ entries, fetchImpl, timeoutMs: 500, concurrency: 4 });
  const results = await prober.runOnce();
  const elapsed = Date.now() - started;

  assert.equal(results.length, 20, 'every entry is still probed and reported');
  // serial would be 20 × 50ms = 1000ms; four at a time is ~250ms. A generous
  // ceiling, because a busy CI runner is not a benchmark machine.
  assert.ok(elapsed < 700, `a bounded sweep took ${elapsed}ms, which is close to serial`);
});

test('results keep the catalogue order, whatever order they finished in', async () => {
  // the first entry is the slowest, so a pool that returned results as they
  // arrived would put it last and shuffle the table between runs
  const entries = entriesFor(8);
  let call = 0;
  const fetchImpl = async () => {
    const index = call++;
    await new Promise((r) => setTimeout(r, index === 0 ? 80 : 5));
    throw new Error('unreachable');
  };
  const prober = new Prober({ entries, fetchImpl, timeoutMs: 500, concurrency: 4 });
  const results = await prober.runOnce();
  assert.deepEqual(
    results.map((r) => r.provider),
    entries.map((e) => e.provider),
  );
});

test('the default bound is a number, and the CLI and the prober cannot disagree', async () => {
  const { DEFAULT_PROBE_CONCURRENCY } = await import('@drsamonline/prober');
  assert.ok(Number.isInteger(DEFAULT_PROBE_CONCURRENCY) && DEFAULT_PROBE_CONCURRENCY >= 2);
  const prober = new Prober({ entries: entriesFor(1) });
  assert.equal(prober.concurrency, DEFAULT_PROBE_CONCURRENCY);
});

test('a bounded sweep still verifies a healthy upstream', async () => {
  const fake = await startFake();
  try {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ...entryFor(fake.url),
      provider: `fake-${i}`,
      base_url: fake.url,
      pool_key: `fake-${i}`,
    }));
    // loopback is opt-in, like everywhere else: this fake upstream is on this machine
    const prober = new Prober({ entries, timeoutMs: 4000, concurrency: 2, allowLocal: true });
    const results = await prober.runOnce();
    assert.equal(results.filter((r) => r.ok).length, 5, 'bounded concurrency must not change what a probe concludes');
  } finally {
    await fake.close();
  }
});

test('sui probe refuses a concurrency that is not a whole number of at least one', async () => {
  const { run: cli } = await import('@drsamonline/cli/src/cli.js');
  const { ConfigError } = await import('@drsamonline/core');
  for (const bad of ['0', '2.5', 'lots']) {
    await assert.rejects(() => cli(['probe', '--concurrency', bad]), ConfigError, `--concurrency ${bad} must be refused`);
  }
  // a value starting with "-" is read as another flag; it must not silently
  // become "true" and then run the whole sweep one entry at a time
  await assert.rejects(() => cli(['probe', '--concurrency', '-1']), ConfigError, 'a bare --concurrency must be refused');
  await assert.rejects(() => cli(['probe', '--concurrency=-1']), ConfigError, 'a negative bound must be refused');
});

test('a socket that never answers cannot hang a sweep', async () => {
  // AbortSignal.timeout does not interrupt a DNS lookup, so a network that drops
  // packets leaves the fetch pending for ever. `sui probe --timeout 2000` was
  // measured running for over five minutes here for exactly this reason.
  const fetchImpl = () => new Promise(() => {});
  const started = Date.now();
  const result = await probeTarget(entryFor('https://blackhole.example/v1'), { fetchImpl, timeoutMs: 100 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.match(result.levels.liveness.note, /timed out/);
  assert.ok(elapsed < 2000, `a probe with a 100ms timeout took ${elapsed}ms`);
});

test('a sweep of 41 blackholed endpoints finishes in bounded time', async () => {
  const fetchImpl = () => new Promise(() => {});
  const entries = entriesFor(41);
  const started = Date.now();
  const prober = new Prober({ entries, fetchImpl, timeoutMs: 50, concurrency: 8 });
  const results = await prober.runOnce();
  const elapsed = Date.now() - started;

  assert.equal(results.length, 41);
  assert.ok(results.every((r) => !r.ok), 'a blackhole is not a verified route');
  // 41 entries, 50ms each, eight at a time: about six waves. Serial with no
  // deadline at all was unbounded, which is the bug this replaces.
  assert.ok(elapsed < 5000, `41 blackholed endpoints took ${elapsed}ms`);
});
