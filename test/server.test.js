import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGateway, testConfig, startFakeUpstream } from './helpers.js';

/** Start a gateway on a free port and return its base URL plus a stop(). */
async function boot(config) {
  const gw = await makeGateway(config);
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {any} */ (gw.server.address());
  return {
    ...gw,
    base: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        gw.server.closeAllConnections?.();
        gw.server.close(() => resolve());
      }),
  };
}

test('POST /v1/chat/completions answers in OpenAI shape with a provenance block', async () => {
  const upstream = await startFakeUpstream();
  const gw = await boot(testConfig({ fakeUrl: upstream.url }));

  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-sui-provider'), 'fake');
  assert.equal(res.headers.get('x-sui-verified'), 'true');
  assert.equal(res.headers.get('x-sui-cached'), 'false');

  const json = await res.json();
  assert.equal(json.object, 'chat.completion');
  assert.match(json.choices[0].message.content, /^upstream:fake-a/);
  assert.equal(json.choices[0].finish_reason, 'stop');
  assert.equal(json.usage.total_tokens, json.usage.prompt_tokens + json.usage.completion_tokens);

  // the chip the UI renders
  assert.equal(json.sui.provider, 'fake');
  assert.equal(json.sui.modelId, 'fake-a');
  assert.equal(json.sui.verified, true);
  assert.equal(json.sui.cached, false);
  assert.equal(json.sui.combo, 'chain');
  assert.ok(json.sui.latencyMs >= 0);
  assert.ok(json.sui.costUsd > 0);

  await gw.stop();
  await upstream.close();
});

test('a second identical request is served from cache and says so', async () => {
  const upstream = await startFakeUpstream();
  const gw = await boot(testConfig({ fakeUrl: upstream.url }));
  const body = JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'same' }] });

  await fetch(`${gw.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const second = await fetch(`${gw.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const json = await second.json();
  assert.equal(json.sui.cached, true);
  assert.equal(second.headers.get('x-sui-cached'), 'true');

  await gw.stop();
  await upstream.close();
});

test('streaming returns SSE chunks and a final provenance frame', async () => {
  const upstream = await startFakeUpstream();
  const gw = await boot(testConfig({ fakeUrl: upstream.url }));

  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', stream: true, messages: [{ role: 'user', content: 'stream please' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(res.headers.get('x-sui-provider'), 'fake');

  const text = await res.text();
  const frames = text.split('\n\n').filter(Boolean);
  assert.ok(frames.length > 3, 'expected several SSE frames');
  assert.ok(text.includes('[DONE]'));

  const payloads = frames
    .map((f) => f.replace(/^data:\s*/, ''))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));

  const content = payloads.map((p) => p.choices?.[0]?.delta?.content ?? '').join('');
  assert.match(content, /^upstream:fake-a/);

  const final = payloads[payloads.length - 1];
  assert.equal(final.sui.provider, 'fake');
  assert.ok(final.usage.prompt_tokens > 0);

  await gw.stop();
  await upstream.close();
});

test('failover is invisible to the client: one 200, one provenance, one attempt list', async () => {
  const upstream = await startFakeUpstream({ fail: true });
  const gw = await boot(testConfig({ fakeUrl: upstream.url }));

  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'will fail over' }] }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.sui.modelId, 'mock-a');
  assert.equal(json.sui.attempts.length, 1);
  assert.equal(json.sui.verified, false, 'the mock provider is not a verified upstream');

  await gw.stop();
  await upstream.close();
});

test('an unknown model gets a 404 that lists where to look', async () => {
  const gw = await boot(testConfig());
  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-imaginary', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.match(json.error.message, /not a combo or model/);
  assert.match(json.error.message, /GET \/v1\/models/);
  await gw.stop();
});

test('exhaustion returns 503 with per-target reasons, never a stack trace', async () => {
  const config = testConfig();
  config.combos.allbad = { label: 'All bad', strategy: 'fallback', targets: ['unkeyed'] };
  const gw = await boot(config);

  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'allbad', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error.type, 'no_route_available');
  assert.match(json.error.message, /no API key set/);
  assert.ok(Array.isArray(json.error.attempts));
  await gw.stop();
});

test('GET /v1/models lists combos, and models with ?all=1', async () => {
  const gw = await boot(testConfig());
  const combos = await (await fetch(`${gw.base}/v1/models`)).json();
  assert.ok(combos.data.some((m) => m.id === 'chain'));

  const all = await (await fetch(`${gw.base}/v1/models?all=1`)).json();
  const fake = all.data.find((m) => m.id === 'fake-a');
  assert.equal(fake.available, true);
  const unkeyed = all.data.find((m) => m.id === 'unkeyed');
  assert.equal(unkeyed.available, false);
  await gw.stop();
});

test('GET /api/status carries everything the dashboard renders', async () => {
  const gw = await boot(testConfig());
  await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'status please' }] }),
  });

  const status = await (await fetch(`${gw.base}/api/status`)).json();
  assert.ok(Array.isArray(status.pool));
  assert.ok(Array.isArray(status.combos));
  assert.ok(status.pool.every((m) => m.health), 'every pool entry needs a health state');
  assert.equal(status.metrics.totals.turns, 1, 'one answered turn');
  assert.equal(status.metrics.totals.failed, 1, 'the unreachable primary is still on the record');
  assert.equal(status.metrics.totals.attempts, 2);
  assert.ok(status.budget.spentUsd >= 0);
  assert.ok(status.cache);
  assert.ok(Array.isArray(status.promptUsage));
  assert.ok(status.unconfigured.some((u) => u.modelId === 'unkeyed'));
  // An env var *name* is a helpful hint; a key *value* must never appear.
  const unkeyed = status.unconfigured.find((u) => u.modelId === 'unkeyed');
  assert.equal(unkeyed.needsEnv, 'DEFINITELY_NOT_SET_KEY');

  const sanitised = await (await fetch(`${gw.base}/api/config`)).json();
  assert.equal('apiKey' in (sanitised.providers.mock ?? {}), false);
  assert.equal(JSON.stringify(sanitised).includes('sk-'), false, 'no key material in the config view');
  await gw.stop();
});

test('toggle validation refuses a change whose dependency is missing', async () => {
  const gw = await boot(testConfig());

  const blocked = await fetch(`${gw.base}/api/config/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disableProvider: 'mock' }),
  });
  assert.equal(blocked.status, 409);
  const json = await blocked.json();
  assert.equal(json.ok, false);
  assert.ok(json.blockers.length >= 1);
  assert.match(json.blockers[0].message, /still backs/);
  assert.ok(json.blockers[0].fix.length > 10, 'a blocker must say how to fix it');

  const allowed = await fetch(`${gw.base}/api/config/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disableModel: 'nothing-uses-this' }),
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).ok, true);
  await gw.stop();
});

test('the CSV export is a real spreadsheet', async () => {
  const gw = await boot(testConfig());
  await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'csv me' }] }),
  });
  const res = await fetch(`${gw.base}/api/metrics.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await res.text();
  const [header, first] = csv.trim().split('\n');
  assert.match(header, /^timestamp_iso,provider,model/);
  assert.equal(first.split(',').length, header.split(',').length);
  await gw.stop();
});

test('the dashboard is served at / and names its own controls', async () => {
  const gw = await boot(testConfig());
  const res = await fetch(`${gw.base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const needle of ['Routing dashboard', 'Export CSV', 'Prompt-free usage', 'Your routing pool', 'start here']) {
    assert.ok(html.includes(needle), `dashboard should contain "${needle}"`);
  }
  await gw.stop();
});

test('breaker reset brings a resting model back', async () => {
  const gw = await boot(testConfig());
  gw.breaker.recordFailure('mock-a', 'test');
  gw.breaker.recordFailure('mock-a', 'test');
  assert.equal(gw.breaker.stateOf('mock-a').state, 'open');

  const res = await fetch(`${gw.base}/api/breaker/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'mock-a' }),
  });
  assert.equal(res.status, 200);
  assert.equal(gw.breaker.stateOf('mock-a').state, 'closed');
  await gw.stop();
});

test('auth: with apiKeys configured, an unauthenticated call is refused', async () => {
  const config = testConfig();
  config.apiKeys = [{ key: 'sk-test-123', name: 'tests', allowedCombos: ['chain'] }];
  const gw = await boot(config);

  const anon = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(anon.status, 401);
  assert.match((await anon.json()).error.message, /needs an API key/);

  const authed = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-123' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(authed.status, 200);

  const forbidden = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-123' },
    body: JSON.stringify({ model: 'cheap', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(forbidden.status, 403);
  await gw.stop();
});

test('a bare model id works as a route, for tools that refuse virtual names', async () => {
  const gw = await boot(testConfig());
  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-b', messages: [{ role: 'user', content: 'direct' }] }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.sui.modelId, 'mock-b');
  await gw.stop();
});
