import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FIXTURES, PROBE_FIXTURE_VERSION, Prober, probeTarget } from '@sui/prober';
import { normalizeEntry } from '@sui/catalog';

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
  const result = await probeTarget(entryFor(fake.url));
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
  const result = await probeTarget(entryFor(fake.url));
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.reasons.join(' '), /readiness: empty completion/);
  await fake.close();
});

test('a 500 fails readiness even though liveness passed', async () => {
  const fake = await startFake({ readiness: '500' });
  const result = await probeTarget(entryFor(fake.url));
  assert.equal(result.levels.liveness.ok, true);
  assert.equal(result.levels.readiness.ok, false);
  assert.equal(result.ok, false);
  await fake.close();
});

test('suitability: one frame pretending to be a stream is caught', async () => {
  const fake = await startFake({ streaming: 'blob' });
  const result = await probeTarget(entryFor(fake.url));
  assert.equal(result.levels.suitability.streaming.ok, false);
  assert.match(result.levels.suitability.streaming.note, /not a real stream/);
  assert.equal(result.ok, false, 'a claimed capability that does not work must fail the probe');
  await fake.close();
});

test('suitability: prose instead of JSON fails the json_schema check', async () => {
  const fake = await startFake({ json: 'prose' });
  const result = await probeTarget(entryFor(fake.url, ['chat', 'json_schema']));
  assert.equal(result.levels.suitability.json_schema.ok, false);
  assert.match(result.levels.suitability.json_schema.note, /not JSON/);
  await fake.close();
});

test('suitability: a rejected tool schema is a failure, not a preference', async () => {
  const fake = await startFake({ tools: 'reject' });
  const result = await probeTarget(entryFor(fake.url, ['chat', 'tools']));
  assert.equal(result.levels.suitability.tools.ok, false);
  assert.match(result.levels.suitability.tools.note, /tools rejected/);
  await fake.close();
});

test('capabilities it does not claim are not probed', async () => {
  const fake = await startFake();
  const result = await probeTarget(entryFor(fake.url, ['chat']));
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
  const result = await probeTarget(entryFor('http://127.0.0.1:1/v1'), { timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.reasons), /unreachable|timed out/);
});

test('an unreachable host is not asked twice: readiness is skipped, not retried', async () => {
  const t0 = Date.now();
  const result = await probeTarget(entryFor('http://127.0.0.1:1/v1'), { timeoutMs: 300 });
  const elapsed = Date.now() - t0;

  assert.equal(result.levels.readiness.ok, false);
  assert.match(result.levels.readiness.note, /not attempted: endpoint unreachable/);
  assert.ok(elapsed < 900, `should fail fast, took ${elapsed}ms`);
  assert.ok(result.reasons.some((r) => /liveness:/.test(r)));
});

test('the prober disables a route after three consecutive failures', async () => {
  const fake = await startFake({ readiness: '500' });
  const prober = new Prober({ entries: [entryFor(fake.url)], failuresBeforeDisable: 3 });

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
  const prober = new Prober({ entries: [entryFor(fake.url)], failuresBeforeDisable: 2 });
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
  const prober = new Prober({ entries: [entryFor(fake.url)] });
  await prober.runOnce();
  const map = prober.probeMap();
  const [key] = Object.keys(map);
  assert.equal(map[key].ok, true);
  assert.ok(map[key].checkedAt);
  await fake.close();
});

test('history is capped, so a long soak cannot grow it without bound', async () => {
  const fake = await startFake();
  const prober = new Prober({ entries: [entryFor(fake.url)] });
  for (let i = 0; i < 30; i++) await prober.runOnce();
  const state = prober.state.get(prober.snapshot()[0].pool_key);
  assert.equal(state.history.length, 24);
  await fake.close();
});

test('start() schedules and stop() clears, without holding the process open', async () => {
  const fake = await startFake();
  const prober = new Prober({ entries: [entryFor(fake.url)], intervalMs: 50 });
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
  const { weatherLabel } = await import('@sui/prober');
  assert.equal(weatherLabel('healthy'), 'thriving');
  assert.equal(weatherLabel('degraded'), 'resting');
  assert.equal(weatherLabel('disabled'), 'down');
  assert.equal(weatherLabel('unverified'), 'unverified', 'never checked is not the same as down');
});

test('the snapshot carries history and a weather word for the map', async () => {
  const fake = await startFake();
  const prober = new Prober({ entries: [entryFor(fake.url)] });
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
  const prober = new Prober({ entries: [entryFor(fake.url)], failuresBeforeDisable: 2 });
  await prober.runOnce();
  await prober.runOnce();

  const row = prober.snapshot()[0];
  assert.equal(row.weather, 'down');
  assert.ok(row.reasons.length > 0);
  assert.equal(row.history.filter((h) => h.ok === false).length, 2);
  await fake.close();
});
