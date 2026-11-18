import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeGateway, testConfig, makeRouter, ask } from './helpers.js';
import { RateLimiter, checkKeyBudget, keySpendToday } from '@drsamonline/gateway/src/limits.js';
import { detectPrefix, cacheHints, PrefixMemory, preparePromptCache } from '@drsamonline/promptcache';
import { hashApiKey } from '@drsamonline/core';

/* ------------------------------------------------- B4.6 prompt caching */

const LONG_PREFIX = 'You are a careful reviewer of Node services. '.repeat(120); // long enough to clear both providers' cache thresholds

test('the prefix is everything before the last user message', () => {
  const detected = detectPrefix([
    { role: 'system', content: LONG_PREFIX },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'the real question' },
  ]);
  assert.equal(detected.prefix.length, 3);
  assert.equal(detected.tail.length, 1);
  assert.equal(detected.tail[0].content, 'the real question');
  assert.ok(detected.prefixChars > 1000);
});

test('a timestamp in the prefix is reported as the reason the cache never hits', () => {
  const detected = detectPrefix([
    { role: 'system', content: `${LONG_PREFIX} Request id: 550e8400-e29b-41d4-a716-446655440000` },
    { role: 'user', content: 'hi' },
  ]);
  assert.ok(detected.volatile.some((v) => v.name === 'uuid'));
});

test('each provider gets the hint it understands, or an honest refusal', () => {
  const big = { prefixChars: 5000, fingerprint: 'abc123' };
  assert.equal(cacheHints('anthropic', big).anthropic.breakpoint, true);
  assert.equal(cacheHints('openai', big).openai.promptCacheKey, 'abc123');

  const small = { prefixChars: 100, fingerprint: 'abc123' };
  assert.equal(cacheHints('anthropic', small).supported, false);
  assert.match(cacheHints('anthropic', small).reason, /Anthropic caches above/);

  const gemini = cacheHints('gemini', big);
  assert.equal(gemini.supported, false);
  assert.match(gemini.reason, /cached-content resource/);
});

test('the second send of the same prefix is warm, the first is cold', () => {
  const memory = new PrefixMemory();
  const messages = [
    { role: 'system', content: LONG_PREFIX },
    { role: 'user', content: 'question' },
  ];
  const first = preparePromptCache({ messages, providerType: 'anthropic', memory });
  const second = preparePromptCache({ messages, providerType: 'anthropic', memory });

  assert.equal(first.warm, false);
  assert.equal(second.warm, true);
  assert.equal(second.sends, 2);
  assert.equal(memory.stats().hitRate, 0.5);
});

test('Anthropic receives a cache_control breakpoint; OpenAI receives a cache key', async () => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 }, content: [{ type: 'text', text: 'ok' }], stop_reason: 'stop' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/v1`;

  const config = testConfig();
  config.providers.anth = { type: 'anthropic', baseUrl: url, apiKeyEnv: null };
  config.providers.oai = { type: 'openai', baseUrl: url, apiKeyEnv: null };
  config.models['anth-1'] = { provider: 'anth', model: 'claude-x', costPer1kIn: 1, costPer1kOut: 1, quality: 4 };
  config.models['oai-1'] = { provider: 'oai', model: 'gpt-x', costPer1kIn: 1, costPer1kOut: 1, quality: 4 };
  config.combos.anth = { strategy: 'fallback', targets: ['anth-1'] };
  config.combos.oai = { strategy: 'fallback', targets: ['oai-1'] };

  const { router } = makeRouter(config);
  const messages = [
    { role: 'system', content: LONG_PREFIX },
    { role: 'user', content: 'review this' },
  ];

  try {
    const a = await router.chat({ combo: 'anth', body: { messages, max_tokens: 32 } });
    assert.equal(Array.isArray(bodies[0].system), true);
    assert.equal(bodies[0].system[0].cache_control.type, 'ephemeral');
    assert.equal(a.meta.promptCache.hint, 'cache_control breakpoint on the prefix');

    // warmth belongs to the prefix, not to the provider: the same system prompt
    // sent to a second provider is still the same prefix.
    const o = await router.chat({ combo: 'oai', body: { messages, max_tokens: 32 } });
    assert.ok(bodies[1].prompt_cache_key, 'OpenAI should receive a prompt_cache_key');
    assert.equal(o.meta.promptCache.warm, true);
    assert.equal(o.meta.promptCache.sends, 2);

    const o2 = await router.chat({ combo: 'oai', body: { messages, max_tokens: 32 } });
    assert.equal(o2.meta.promptCache.warm, true);
    assert.equal(o2.meta.promptCache.sends, 3);
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  }
});

/* --------------------------------------------------- B6.6 per-key limits */

test('the token bucket refuses past the burst and refills over time', () => {
  let clock = 0;
  const limiter = new RateLimiter({ now: () => clock });
  const limit = { rpm: 60, burst: 2 };

  assert.equal(limiter.check('k', limit).ok, true);
  assert.equal(limiter.check('k', limit).ok, true);
  const third = limiter.check('k', limit);
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterMs > 0);

  clock += 1000; // one second = one token at 60 rpm
  assert.equal(limiter.check('k', limit).ok, true);
});

test('a key with no rate limit is not limited', () => {
  const limiter = new RateLimiter({ now: () => 0 });
  for (let i = 0; i < 50; i++) assert.equal(limiter.check('k', {}).ok, true);
});

test('key spend is counted from the ledger, by name', () => {
  const ledger = { entries: () => [
    { apiKey: 'team-a', costUsd: 0.2, ok: true, ts: Date.now() },
    { apiKey: 'team-a', costUsd: 0.1, ok: true, ts: Date.now() },
    { apiKey: 'team-b', costUsd: 9, ok: true, ts: Date.now() },
  ] };
  const spend = keySpendToday(ledger, 'team-a');
  assert.equal(spend.spentUsd, 0.3);
  assert.equal(spend.turns, 2);
});

test('a key over its daily cap is refused with the numbers in the message', () => {
  const ledger = { entries: () => [{ apiKey: 'team-a', costUsd: 0.5, ok: true, ts: Date.now() }] };
  const result = checkKeyBudget({ keyMeta: { name: 'team-a', dailyUsd: 0.25 }, ledger });
  assert.equal(result.ok, false);
  assert.match(result.message, /\$0\.5000 of its \$0\.25 daily cap/);
});

test('the gateway answers 429 when a key is over its rate limit', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'fast', key_hash: hashApiKey('sk-fast'), rateLimit: { rpm: 60, burst: 1 } }];
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  const call = () =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fast' },
      body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hi' }] }),
    });

  assert.equal((await call()).status, 200);
  const limited = await call();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  const json = await limited.json();
  assert.equal(json.error.type, 'rate_limited');
  assert.match(json.error.message, /rate limit/);
  await gw.close();
});

test('the gateway answers 429 when a key is over its spend cap', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'spent', key_hash: hashApiKey('sk-spent'), dailyUsd: 0.0001 }];
  const gw = await makeGateway(config);
  gw.ledger.record({ apiKey: 'spent', provider: 'mock', modelId: 'mock-a', costUsd: 0.5, ok: true });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-spent' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, 'key_budget_reached');
  await gw.close();
});

test('a key can carry tighter guardrails than the gateway', async () => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const config = testConfig({ fakeUrl: `http://127.0.0.1:${port}/v1` });
  const { router } = makeRouter(config);
  await router.chat({
    combo: 'chain',
    body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 },
    keyMeta: { name: 'tight', guardrails: { maxOutputTokens: 16 } },
  });
  assert.equal(bodies[0].max_tokens, 16, 'the key guardrail must win over the request');
  await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
});

/* ------------------------------ the budget must not stop counting (review) */

test('spend is counted from the daily total, not from the record window', async () => {
  const { Ledger } = await import('@drsamonline/telemetry');
  const ledger = new Ledger({ file: null, maxRecords: 100 });
  const now = Date.now();

  // 250 turns at a cent each: the window holds 100, the day holds all of them
  for (let i = 0; i < 250; i++) ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.01, ts: now });

  assert.equal(ledger.records.length, 100, 'the memory window is still bounded');
  assert.equal(ledger.todaySpendUsd(), 2.5, 'and the budget still sees every turn');
});

test('per-provider spend survives the window too', async () => {
  const { Ledger } = await import('@drsamonline/telemetry');
  const ledger = new Ledger({ file: null, maxRecords: 50 });
  const now = Date.now();
  for (let i = 0; i < 120; i++) {
    ledger.record({ provider: i % 2 ? 'a' : 'b', modelId: 'm', ok: true, costUsd: 0.01, ts: now });
  }
  assert.equal(ledger.providerSpendToday('a'), 0.6);
  assert.equal(ledger.providerSpendToday('b'), 0.6);
});

test('a restart rebuilds the day from the file, not from the window', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Ledger } = await import('@drsamonline/telemetry');

  const file = join(mkdtempSync(join(tmpdir(), 'sui-ledger-')), 'ledger.jsonl');
  const now = Date.now();
  const first = new Ledger({ file, maxRecords: 50 });
  for (let i = 0; i < 200; i++) first.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.005, ts: now });

  const reopened = new Ledger({ file, maxRecords: 50 });
  assert.equal(reopened.records.length, 50, 'the window is bounded after a restart');
  assert.equal(reopened.todaySpendUsd(), 1, 'but the day is rebuilt from the whole file');
});

test('the ledger file is rotated rather than growing forever', async () => {
  const { mkdtempSync, existsSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Ledger } = await import('@drsamonline/telemetry');

  const dir = mkdtempSync(join(tmpdir(), 'sui-rotate-'));
  const file = join(dir, 'ledger.jsonl');
  const ledger = new Ledger({ file, maxFileBytes: 2048 });
  const now = Date.now();

  for (let i = 0; i < 200; i++) ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.001, ts: now, note: 'x'.repeat(80) });

  assert.ok(existsSync(`${file}.1`), 'the old file was kept as .1');
  assert.ok(statSync(file).size < 4096, `the live file stayed small (${statSync(file).size} bytes)`);
  assert.equal(ledger.todaySpendUsd(), 0.2, 'and rotation did not lose the day total');
});
