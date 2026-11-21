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
