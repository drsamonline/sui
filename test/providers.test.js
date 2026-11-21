import test from 'node:test';
import assert from 'node:assert/strict';
test('a retired model id is rediscovered from the provider and retried once', async () => {
  const { createAdapter } = await import('../packages/providers/src/index.js');
  const http = await import('node:http');

  // Groq shut down llama-3.3-70b-versatile in August 2026. Every catalogue that
  // still named it started answering "that model does not exist", so the adapter
  // asks the provider what it serves and retries — a hardcoded model id in a config
  // file cannot keep up with a provider's deprecation schedule.
  let asked = [];
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-120b' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const model = JSON.parse(body || '{}').model;
      if (model === 'llama-3.3-70b-versatile') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }], usage: {} }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const adapter = createAdapter('groq', {
      type: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      timeoutMs: 5000,
    });

    const result = await adapter.chat({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(result.text, 'ready');
    assert.equal(result.modelSwitchedFrom, 'llama-3.3-70b-versatile', 'it says what it moved off');
    assert.equal(result.model, 'openai/gpt-oss-120b', 'and what it moved to');
    assert.ok(asked.some((a) => a.includes('/models')), 'it asked the provider what it serves');
    // audio and embedding models are not chat models
    assert.equal(result.model.includes('whisper'), false);
  } finally {
    server.close();
  }
});

test('a rejected key says how to fix it, not just that it was rejected', async () => {
  const { createAdapter } = await import('../packages/providers/src/index.js');
  const http = await import('node:http');

  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const adapter = createAdapter('gemini', { type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bad', timeoutMs: 5000 });
    await adapter.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    assert.fail('a rejected key must throw');
  } catch (err) {
    assert.match(err.message, /rejected the API key/);
    // the person reading it needs somewhere to go
    assert.match(err.message, /console\.groq\.com\/keys|aistudio\.google\.com\/apikey/);
    assert.match(err.message, /unset it/);
  } finally {
    server.close();
  }
});

test('a key with spaces, quotes or a Bearer prefix is cleaned before use', async () => {
  const { sanitiseKey } = await import('../packages/core/src/index.js');

  // every one of these is what a key looks like after being pasted into a Windows
  // terminal, and every one of them makes the provider answer 401
  assert.equal(sanitiseKey('  gsk_abc123  '), 'gsk_abc123');
  assert.equal(sanitiseKey('"gsk_abc123"'), 'gsk_abc123');
  assert.equal(sanitiseKey("'gsk_abc123'"), 'gsk_abc123');
  assert.equal(sanitiseKey('Bearer gsk_abc123'), 'gsk_abc123');
  assert.equal(sanitiseKey('gsk_abc123\r\n'), 'gsk_abc123');
  assert.equal(sanitiseKey('gsk_abc\u00a0123'), 'gsk_abc 123'.replace(' ', ' ')); // nbsp becomes a space, not a silent drop
  assert.equal(sanitiseKey('   '), undefined);
  assert.equal(sanitiseKey(null), undefined);
  assert.equal(sanitiseKey(undefined), undefined);
});

test('doctor shows what it can see about a key without printing the key', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'sui-creds-'));
  // init exits non-zero when the round-trip fails, and with no network it does:
  // the config is still written, which is what this test needs
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync(process.execPath, [join(process.cwd(), 'apps/cli/bin/sui.js'), 'init', '--no-serve'], {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, SUI_HOME: home, GROQ_API_KEY: '  "gsk_secret_value_123456"  ' },
    timeout: 120_000,
  }).stdout;

  const doctor = spawnSync(process.execPath, [join(process.cwd(), 'apps/cli/bin/sui.js'), 'doctor'], {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, SUI_HOME: home, GROQ_API_KEY: '  "gsk_secret_value_123456"  ' },
    timeout: 120_000,
  }).stdout;

  // "rejected the API key" is useless when the key is fine and a trailing space is not
  assert.match(doctor, /GROQ_API_KEY/);
  assert.match(doctor, /chars/);
  assert.match(doctor, /had spaces or quotes/);
  assert.equal(doctor.includes('gsk_secret_value_123456'), false, 'the key itself must never be printed');
  assert.ok(out.includes('Config written'));
});

test('a reasoning model that answers with reasoning and no content is not an empty turn', async () => {
  const { createAdapter } = await import('../packages/providers/src/index.js');
  const http = await import('node:http');

  // Groq's gpt-oss models answer with the thinking in `reasoning` and leave
  // `content` empty when the token budget runs out. Reading only `content` reported
  // "empty turn" for a request that had been answered.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'ready' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 16 },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const adapter = createAdapter('groq', { type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', timeoutMs: 5000 });
    const result = await adapter.chat({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.text, 'ready', 'the reasoning is the answer when content is empty');
  } finally {
    server.close();
  }
});
