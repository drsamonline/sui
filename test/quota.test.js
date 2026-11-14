import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeRouter, testConfig, ask } from './helpers.js';
import { parseRetryAfter } from '@sui/providers';

/* ------------------------------------------------------------ the parsing */

const headers = (value) => ({ get: (k) => (k.toLowerCase() === 'retry-after' ? value : null) });

test('retry-after is read as seconds, as a date, or out of the body', () => {
  assert.equal(parseRetryAfter(headers('30')), 30000);
  assert.ok(parseRetryAfter(headers(new Date(Date.now() + 45000).toUTCString())) > 40000);
  assert.equal(parseRetryAfter(headers(null), 'rate limited, retry_after 12 seconds'), 12000);
  assert.equal(parseRetryAfter(headers(null), 'retry-after: 250 ms'), 250);
  assert.equal(parseRetryAfter(headers(null), 'boom'), 0);
});

/* ------------------------------------------------------- the quota window */

/** An upstream that 429s with Retry-After until `openAfter` ms have passed. */
async function rateLimitedUpstream({ retryAfterSeconds = 30 } = {}) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function quotaConfig(url) {
  const config = testConfig();
  config.providers.limited = { type: 'openai', baseUrl: url, apiKeyEnv: null, timeoutMs: 3000 };
  config.providers.backup = { type: 'mock', mock: { delayMs: 1 } };
  config.models['limited-1'] = { provider: 'limited', model: 'limited-model', costPer1kIn: 0, costPer1kOut: 0, quality: 4 };
  config.models['backup-1'] = { provider: 'backup', model: 'backup-model', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.combos.chain = { strategy: 'fallback', targets: ['limited-1', 'backup-1'] };
  config.combos.only = { strategy: 'fallback', targets: ['limited-1'] };
  config.breaker = { failures: 5, cooldownMs: 1000 };
  return config;
}

test('a 429 with Retry-After closes that target for exactly that long', async () => {
  const up = await rateLimitedUpstream({ retryAfterSeconds: 30 });
  const { router } = makeRouter(quotaConfig(up.url));

  const first = await router.chat({ combo: 'chain', body: ask('hello') });
  assert.equal(first.meta.modelId, 'backup-1', 'the backup answered while the first was closed');
  assert.ok(first.meta.attempts.some((a) => /limited-1/.test(a.modelId)));

  const windows = router.quotaSnapshot();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].modelId, 'limited-1');
  assert.ok(windows[0].reopensInMs > 25000 && windows[0].reopensInMs <= 30000);

  // the closed target is now skipped, not retried
  const second = await router.chat({ combo: 'chain', body: ask('hello') });
  assert.equal(second.meta.modelId, 'backup-1');
  assert.equal(up.calls(), 1, 'the limited provider was not called a second time');
  assert.ok(second.meta.route.considered.some((c) => c.outcome === 'skipped' && /quota window closed/.test(c.reason)));
  await up.close();
});

test('when the window passes, the target is tried again and the window is cleared', async () => {
  const up = await rateLimitedUpstream({ retryAfterSeconds: 1 });
  let clock = Date.now();
  const config = quotaConfig(up.url);
  const { router } = makeRouter(config);
  router.now = () => clock;

  const first = await router.chat({ combo: 'chain', body: ask('hello') });
  assert.equal(first.meta.modelId, 'backup-1');
  assert.equal(router.quotaSnapshot().length, 1);

  clock += 1500; // the window has passed
  const second = await router.chat({ combo: 'chain', body: ask('hello') });
  assert.equal(second.meta.modelId, 'limited-1', 'the reopened target answers again');
  assert.equal(router.quotaSnapshot().length, 0, 'the window is cleared once honoured');
  await up.close();
});

test('a quota window is not a breaker trip: the route is skipped, not rested', async () => {
  const up = await rateLimitedUpstream({ retryAfterSeconds: 30 });
  const { router } = makeRouter(quotaConfig(up.url));

  await router.chat({ combo: 'chain', body: ask('hello') });
  const breaker = router.breaker.snapshot().find((b) => b.key === 'limited-1');
  assert.notEqual(breaker?.state, 'open', '429 is a quota fact, not a health signal (I13)');
  await up.close();
});

test('a single-target combo with a closed window fails closed with the reason', async () => {
  const up = await rateLimitedUpstream({ retryAfterSeconds: 30 });
  const { router } = makeRouter(quotaConfig(up.url));

  await assert.rejects(() => router.chat({ combo: 'only', body: ask('hello') }), (err) => {
    assert.equal(err.code, 'no_route_available');
    assert.match(err.message, /quota window closed|rate|429/i);
    return true;
  });
  await up.close();
});
