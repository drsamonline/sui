import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { discoverLocalRuntimes, isLoopback, toConfigPatch, DEFAULT_PORTS } from '@drsamonline/prober';
import { applyRecipe } from '@drsamonline/core';

/** An Ollama-shaped server. */
async function fakeOllama(models = ['qwen2.5-coder:7b', 'llama3.2:3b']) {
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

/** An OpenAI-compatible server (LM Studio, vLLM, llama.cpp). */
async function fakeOpenAi(models = ['mistral-7b-instruct']) {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

test('loopback is the only thing that may be probed', async () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('192.168.1.10'), false);
  assert.equal(isLoopback('example.com'), false);

  await assert.rejects(() => discoverLocalRuntimes({ hosts: ['192.168.1.10'] }), /loopback-only/);
});

test('an Ollama server is found, with the models it serves', async () => {
  const ollama = await fakeOllama();
  const found = await discoverLocalRuntimes({ ports: [ollama.port] });

  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'ollama');
  assert.deepEqual(found[0].models, ['qwen2.5-coder:7b', 'llama3.2:3b']);
  assert.equal(found[0].baseUrl, `http://127.0.0.1:${ollama.port}`);
  await ollama.close();
});

test('an OpenAI-compatible server is found too', async () => {
  const lmstudio = await fakeOpenAi();
  const found = await discoverLocalRuntimes({ ports: [lmstudio.port] });

  assert.equal(found[0].kind, 'openai-compatible');
  assert.deepEqual(found[0].models, ['mistral-7b-instruct']);
  assert.match(found[0].baseUrl, /\/v1$/);
  await lmstudio.close();
});

test('a closed port is not an error and does not slow the scan down', async () => {
  const started = Date.now();
  const found = await discoverLocalRuntimes({ ports: [1, 2, 3], timeoutMs: 120 });
  const elapsed = Date.now() - started;

  assert.deepEqual(found, []);
  assert.ok(elapsed < 2000, `a closed port should fail fast, took ${elapsed}ms`);
});

test('the default port list is the set those servers actually use', () => {
  assert.ok(DEFAULT_PORTS.includes(11434), 'Ollama');
  assert.ok(DEFAULT_PORTS.includes(1234), 'LM Studio');
  assert.ok(DEFAULT_PORTS.includes(8080), 'llama.cpp / LocalAI');
});

test('discovery produces a config patch that applies cleanly and idempotently', async () => {
  const ollama = await fakeOllama(['qwen2.5-coder:7b']);
  const found = await discoverLocalRuntimes({ ports: [ollama.port] });
  const patch = toConfigPatch(found[0]);

  assert.equal(patch.providers.ollama.baseUrl, `http://127.0.0.1:${ollama.port}`);
  assert.equal(patch.providers.ollama.apiKeyEnv, null, 'a local server needs no key');
  assert.equal(patch.providers.ollama.tier, 'free');
  assert.deepEqual(Object.keys(patch.models), ['ollama-qwen2.5-coder-7b']);
  assert.deepEqual(patch.combos.local.targets, ['ollama-qwen2.5-coder-7b']);

  const base = { providers: {}, models: {}, combos: {}, env: {} };
  const recipe = { name: 'local', title: 'Local', description: 'discovered', patch };
  const once = applyRecipe(base, recipe);
  const twice = applyRecipe(once.config, recipe);

  assert.ok(once.changes.length > 0);
  assert.equal(twice.changes.length, 0, 'discovering twice must not duplicate anything');
  await ollama.close();
});

test('a model name with odd characters still produces a usable id', () => {
  const patch = toConfigPatch({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['Llama 3.2:3B Instruct/Q4'] });
  const id = Object.keys(patch.models)[0];
  assert.match(id, /^[a-z0-9._-]+$/, `id "${id}" must be safe to use as a config key`);
});
