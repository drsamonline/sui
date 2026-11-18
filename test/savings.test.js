import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeRouter, makeGateway, testConfig, ask } from './helpers.js';
import { Ledger } from '@drsamonline/telemetry';
import { STYLE_DIRECTIVES, chooseStyle } from '@drsamonline/compression';

const PROMPT = `You are helping with a Node service. The handler is basically just a very simple health check that returns ok and nothing else at all really. It does not do anything else at all. The handler is used by the load balancer. See https://example.com/docs for the contract. Please summarise it and say whether it is safe to expose publicly.`;

async function capturingUpstream() {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 2 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/* ------------------------------------------------------- B4.4 output axis */

test('the style dial tightens as the quota empties, and reads a code task', () => {
  assert.equal(chooseStyle({ fraction: 0.9 }).style, 'explanatory');
  assert.equal(chooseStyle({ fraction: 0.5 }).style, 'terse');
  assert.equal(chooseStyle({ fraction: 0.1 }).style, 'bullet');
  assert.equal(chooseStyle({ fraction: 0.9, taskHint: 'refactor this function' }).style, 'code_only');
});

test('every directive is short enough to be worth sending', () => {
  for (const [style, text] of Object.entries(STYLE_DIRECTIVES)) {
    assert.ok(text.length <= 90, `${style} directive is ${text.length} chars`);
    assert.equal(text.includes('\n'), false, `${style} should be one line`);
  }
});

test('a style is injected without losing the existing system message', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  config.compression = { enabled: false, outputStyle: 'terse' };
  const { router } = makeRouter(config);

  const res = await router.chat({
    combo: 'chain',
    body: { messages: [{ role: 'system', content: 'You are a careful reviewer.' }, { role: 'user', content: 'hi' }], max_tokens: 32 },
  });

  const sent = upstream.bodies[0].messages;
  assert.equal(sent[0].role, 'system');
  assert.ok(sent[0].content.startsWith(STYLE_DIRECTIVES.terse));
  assert.ok(sent[0].content.includes('You are a careful reviewer.'));
  assert.equal(res.meta.compression.style, 'terse');
  await upstream.close();
});

test('a system message is created when there is none', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  config.compression = { enabled: false, outputStyle: 'code_only' };
  const { router } = makeRouter(config);

  await router.chat({ combo: 'chain', body: ask('write a function') });
  assert.equal(upstream.bodies[0].messages[0].role, 'system');
  assert.equal(upstream.bodies[0].messages[0].content, STYLE_DIRECTIVES.code_only);
  await upstream.close();
});

test('style auto follows the same quota reading as the preset', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  config.compression = { enabled: false, outputStyle: 'auto' };
  config.budgets = { dailyUsd: null, warnAtPct: 80, perProvider: { fake: 0.001 } };
  const { router, ledger } = makeRouter(config);
  ledger.record({ provider: 'fake', modelId: 'fake-a', costUsd: 0.00095, ts: Date.now() });

  const res = await router.chat({ combo: 'chain', body: ask('explain this') });
  assert.equal(res.meta.compression.style, 'bullet');
  assert.match(res.meta.compression.styleReason, /quota left/);
  await upstream.close();
});

test('with the axis off, nothing is injected and nothing is reported', async () => {
  const upstream = await capturingUpstream();
  const { router } = makeRouter(testConfig({ fakeUrl: upstream.url }));
  const res = await router.chat({ combo: 'chain', body: ask('hi') });
  assert.equal(res.meta.compression, null);
  assert.equal(upstream.bodies[0].messages.length, 1);
  await upstream.close();
});

/* ----------------------------------------------------- B7.2 savings ledger */

test('compression savings are valued at the model price and recorded', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  // prefix protection off: with it on (the default) the system message is left
  // alone so a provider prefix cache keeps hitting — covered in compression.test.js
  config.compression = { enabled: true, preset: 'aggressive', minChars: 100, preserveCachedPrefix: false };
  const { router, ledger } = makeRouter(config);

  const res = await router.chat({
    combo: 'chain',
    body: { messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: 'go' }], max_tokens: 32 },
  });

  assert.ok(res.meta.compression.savedChars > 0);
  assert.ok(res.meta.savedUsd > 0, 'savings should be valued in dollars');
  const row = ledger.records.find((r) => r.ok);
  assert.equal(row.compressionPreset, 'aggressive');
  assert.ok(row.compressionSavedTokens > 0);
  assert.equal(row.compressionSavedUsd, res.meta.savedUsd);
  await upstream.close();
});

test('the aggregate separates cache savings from compression savings', async () => {
  const ledger = new Ledger({ file: null });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.002, cached: true });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.001, compressionSavedUsd: 0.0004, compressionSavedTokens: 40 });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.001 });

  const agg = ledger.aggregate({ since: 0 });
  assert.equal(agg.totals.savings.cacheUsd, 0.002);
  assert.equal(agg.totals.savings.compressionUsd, 0.0004);
  assert.equal(agg.totals.savings.totalUsd, 0.0024);
  assert.equal(agg.totals.savings.tokensSaved, 40);
  assert.equal(agg.totals.savings.cacheHits, 1);
  assert.equal(agg.totals.savings.compressedTurns, 1);
  assert.equal(agg.totals.savedUsd, 0.0024, 'savedUsd stays the total for older readers');
});

test('the CSV export carries the compression columns', () => {
  const ledger = new Ledger({ file: null });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.001, compressionPreset: 'ultra', compressionSavedTokens: 12, compressionSavedUsd: 0.0001 });
  const [header, row] = ledger.csv().trim().split('\n');
  assert.match(header, /compression_preset,compression_saved_tokens,compression_saved_usd/);
  assert.match(row, /ultra,12,0\.0001/);
});

test('/api/savings reports the ledger savings and the share avoided', async () => {
  const gw = await makeGateway(testConfig());
  gw.ledger.record({ provider: 'mock', modelId: 'mock-a', ok: true, costUsd: 0.003, cached: true });
  gw.ledger.record({ provider: 'mock', modelId: 'mock-a', ok: true, costUsd: 0.001, compressionSavedUsd: 0.001, compressionSavedTokens: 100 });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const json = await (await fetch(`http://127.0.0.1:${port}/api/savings`)).json();
  assert.equal(json.savings.cacheUsd, 0.003);
  assert.equal(json.savings.compressionUsd, 0.001);
  assert.equal(json.savings.tokensSaved, 100);
  assert.equal(json.spentUsd, 0.004);
  assert.equal(json.avoidedShare, 0.5, '4 cents spent, 4 cents avoided');
  await gw.close();
});
