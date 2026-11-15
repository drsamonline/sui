/**
 * Test helpers: a fake OpenAI-compatible upstream, and a gateway wired to it.
 * Everything here is local — the suite never touches the internet or needs a key.
 */

import { createServer } from 'node:http';
import { createGateway } from '@sui/gateway';

export { createGateway };
import { Ledger } from '@sui/telemetry';
import { CircuitBreaker } from '@sui/router';
import { ResponseCache } from '@sui/telemetry';
import { Router } from '@sui/router';

/**
 * A tiny OpenAI-shaped upstream. `behaviour.fail` makes it return an error,
 * which is how the failover tests simulate an outage.
 */
export async function startFakeUpstream(opts = {}) {
  const behaviour = { fail: false, status: 503, delayMs: 0, ...opts };
  let calls = 0;

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls += 1;

    if (behaviour.fail) {
      res.writeHead(behaviour.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'simulated upstream outage' } }));
      return;
    }
    if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));

    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    const text = `upstream:${body.model}:${String(lastUser?.content ?? '').slice(0, 40)}`;

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const word of text.match(/\S+\s*/g) ?? []) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {any} */ (server.address());

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    behaviour,
    get calls() {
      return calls;
    },
    close: () =>
      new Promise((resolve) => {
        // fetch keeps sockets alive; without this, close() never resolves
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Config with one mock provider (always answers) and one HTTP provider pointed
 * at the fake upstream, so both the "no network" and "real socket" paths are
 * exercised.
 */
export function testConfig(overrides = {}) {
  return {
    server: { host: '127.0.0.1', port: 0, cache: { enabled: true, ttlMs: 60000, maxEntries: 50 } },
    providers: {
      mock: { type: 'mock', mock: { delayMs: 1 } },
      fake: { type: 'openai', baseUrl: overrides.fakeUrl ?? 'http://127.0.0.1:1/v1', apiKeyEnv: null, timeoutMs: 3000 },
      'no-key': { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'DEFINITELY_NOT_SET_KEY' },
    },
    models: {
      'mock-a': { provider: 'mock', model: 'mock-a', costPer1kIn: 0, costPer1kOut: 0, quality: 2, label: 'Mock A' },
      'mock-b': { provider: 'mock', model: 'mock-b', costPer1kIn: 0.5, costPer1kOut: 1, quality: 4, label: 'Mock B' },
      'fake-a': { provider: 'fake', model: 'fake-a', costPer1kIn: 0.1, costPer1kOut: 0.2, quality: 3, label: 'Fake A' },
      'unkeyed': { provider: 'no-key', model: 'unkeyed', costPer1kIn: 0, costPer1kOut: 0, quality: 5, label: 'Unkeyed' },
    },
    combos: {
      'chain': { label: 'Chain', strategy: 'fallback', targets: ['fake-a', 'mock-a'] },
      'weighted': { label: 'Split', strategy: 'weighted', targets: [{ model: 'mock-a', weight: 70 }, { model: 'mock-b', weight: 30 }] },
      'cheap': { label: 'Cheap', strategy: 'cheapest', minQuality: 2, targets: ['mock-b', 'mock-a', 'fake-a'] },
      'gated': { label: 'Gated', strategy: 'fallback', targets: ['unkeyed', 'mock-a'] },
    },
    breaker: { failures: 2, cooldownMs: 50, halfOpenSuccesses: 1 },
    budgets: { dailyUsd: null, warnAtPct: 80, perProvider: {} },
    guardrails: { maxOutputTokens: 256, maxInputChars: 10000, blockPatterns: [], logPrompts: false, redactPiiInLogs: true },
    apiKeys: [],
    ...overrides.config,
  };
}

/** A Router with an in-memory ledger — no files, no env, no surprises. */
export function makeRouter(config, opts = {}) {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const normalised = { ...config, env };
  const ledger = new Ledger({ file: null });
  const breaker = new CircuitBreaker({ ...config.breaker, now: opts.now });
  const cache = new ResponseCache({ ...config.server.cache, enabled: opts.cache ?? false });
  const router = new Router({ config: normalised, ledger, breaker, cache, random: opts.random ?? Math.random, now: opts.now });
  return { router, ledger, breaker, cache, config: normalised };
}

/** A full gateway (server included) for HTTP-level tests. */
export async function makeGateway(config, opts = {}) {
  return createGateway({
    configObject: config,
    env: { ...process.env },
    ledgerFile: null,
    ...opts,
  });
}

export const ask = (content = 'hello') => ({
  messages: [{ role: 'user', content }],
  max_tokens: 32,
});
