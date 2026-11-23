import test from 'node:test';
import assert from 'node:assert/strict';
import { tenantSnapshot, tenantSummary, hashApiKey } from '@drsamonline/core';
import http from 'node:http';
import { makeGateway, testConfig } from './helpers.js';

const ledgerOf = (rows) => ({ entries: () => rows });

/* -------------------------------------------------------- the snapshot */

test('a tenant with no cap is uncapped, not at zero percent', () => {
  const config = { apiKeys: [{ name: 'open', key_hash: 'x'.repeat(64) }] };
  const [tenant] = tenantSnapshot({ config, ledger: ledgerOf([{ apiKey: 'open', costUsd: 1, ok: true, ts: 1 }]) });
  assert.equal(tenant.dailyUsd, null);
  assert.equal(tenant.pct, null, 'an uncapped tenant has no percentage');
  assert.equal(tenant.remainingUsd, null);
  assert.equal(tenant.spentUsd, 1, 'but the spend is still real');
});

test('a capped tenant reports spent, remaining and percent', () => {
  const config = { apiKeys: [{ name: 'a', key_hash: 'x'.repeat(64), dailyUsd: 2 }] };
  const [tenant] = tenantSnapshot({
    config,
    ledger: ledgerOf([
      { apiKey: 'a', costUsd: 1.5, ok: true, ts: 5 },
      { apiKey: 'a', costUsd: 0.25, ok: true, ts: 7 },
      { apiKey: 'a', costUsd: 0, ok: false, ts: 9 },
    ]),
  });
  assert.equal(tenant.spentUsd, 1.75);
  assert.equal(tenant.remainingUsd, 0.25);
  assert.equal(tenant.pct, 87.5);
  assert.equal(tenant.turns, 2);
  assert.equal(tenant.failed, 1);
  assert.equal(tenant.lastSeenAt, 9);
});

test('the snapshot never returns the key, only whether a hash is stored', () => {
  const config = { apiKeys: [{ name: 'a', key: 'sk-plaintext-should-not-appear', key_hash: 'x'.repeat(64) }] };
  const [tenant] = tenantSnapshot({ config, ledger: ledgerOf([]) });
  assert.equal(JSON.stringify(tenant).includes('sk-plaintext'), false);
  assert.equal(tenant.hasKeyHash, true);
});

test('the summary names the tenant closest to its cap', () => {
  const config = {
    apiKeys: [
      { name: 'near', key_hash: 'x'.repeat(64), dailyUsd: 1 },
      { name: 'far', key_hash: 'x'.repeat(64), dailyUsd: 100 },
      { name: 'open' },
    ],
  };
  const snap = tenantSnapshot({
    config,
    ledger: ledgerOf([
      { apiKey: 'near', costUsd: 0.95, ok: true, ts: 1 },
      { apiKey: 'far', costUsd: 1, ok: true, ts: 1 },
    ]),
  });
  const summary = tenantSummary(snap);
  assert.equal(summary.tenants, 3);
  assert.equal(summary.capped, 2);
  assert.equal(summary.uncapped, 1);
  assert.equal(summary.nearestCap, 'near');
});

/* ------------------------------------------------------ over HTTP */

async function bootTenants(config) {
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  return { gw, base: `http://127.0.0.1:${port}` };
}

test('the console lists tenants with their spend and their limits', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'team-a', key_hash: hashApiKey('sk-a'), dailyUsd: 2, rateLimit: { rpm: 60 } }];
  const { gw, base } = await bootTenants(config);
  gw.ledger.record({ apiKey: 'team-a', provider: 'mock', modelId: 'mock-a', ok: true, costUsd: 1.5 });

  const json = await (await fetch(`${base}/api/tenants`)).json();
  assert.equal(json.summary.tenants, 1);
  assert.equal(json.tenants[0].name, 'team-a');
  assert.equal(json.tenants[0].pct, 75);
  assert.equal(json.tenants[0].rateLimit.rpm, 60);
  await gw.close();
});

test('a budget change applies to the next request, and says it is not persisted', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'team-a', key_hash: hashApiKey('sk-a'), dailyUsd: 0.001 }];
  const { gw, base } = await bootTenants(config);
  gw.ledger.record({ apiKey: 'team-a', provider: 'mock', modelId: 'mock-a', ok: true, costUsd: 0.5 });

  const call = () =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-a' },
      body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hello' }] }),
    });

  assert.equal((await call()).status, 429, 'over its cap');

  const patched = await (await fetch(`${base}/api/tenants/team-a`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dailyUsd: 5 }),
  })).json();
  assert.equal(patched.tenant.dailyUsd, 5);
  assert.match(patched.note, /not permanent|in memory/i);

  assert.equal((await call()).status, 200, 'the raised cap takes effect immediately');
  await gw.close();
});

test('an admin token, when configured, is required for the console', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'team-a', key_hash: hashApiKey('sk-a') }];
  const previous = process.env.SUI_ADMIN_TOKEN;
  process.env.SUI_ADMIN_TOKEN = 'adm1n'; // the gateway reads the environment at startup
  const { gw, base } = await bootTenants(config);

  try {
    const denied = await fetch(`${base}/api/tenants`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.type, 'admin_required');

    const allowed = await fetch(`${base}/api/tenants`, { headers: { 'x-sui-admin': 'adm1n' } });
    assert.equal(allowed.status, 200);
  } finally {
    await gw.close();
    if (previous === undefined) delete process.env.SUI_ADMIN_TOKEN;
    else process.env.SUI_ADMIN_TOKEN = previous;
  }
});

test('patching an unknown tenant is a 404, and a bad value is a 400', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'team-a', key_hash: hashApiKey('sk-a') }];
  const { gw, base } = await bootTenants(config);

  const missing = await fetch(`${base}/api/tenants/ghost`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"dailyUsd":1}' });
  assert.equal(missing.status, 404);

  const bad = await fetch(`${base}/api/tenants/team-a`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"dailyUsd":-5}' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.type, 'bad_budget');
  await gw.close();
});

/* ------------------------------------------- per-key pinning (0.12.10) */

test('a key pinned to one model refuses to be steered elsewhere', async () => {
  const { makeGateway, testConfig } = await import('./helpers.js');
  const { hashApiKey } = await import('@drsamonline/core');

  const config = testConfig();
  config.apiKeys = [{ key_hash: hashApiKey('pinned-key'), name: 'pinned', forcedModel: 'chain' }];

  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  const headers = { authorization: 'Bearer pinned-key', 'content-type': 'application/json' };

  // asking for something else is a refusal, not a silent redirect
  const refused = await post(port, headers, { model: 'cheap', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error.message, /pinned to "chain"/);

  // no model at all resolves to the pinned one
  const ok = await post(port, headers, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.model, 'chain', 'the pinned combo answered, not one the caller named');

  await gw.close();
});

function post(port, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(payload) }, agent: false },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/* ------------------------------------- what the console must be able to explain */

test('the snapshot carries the pin, so a 403 has a visible cause', () => {
  // `forcedModel` decides which model a request may reach and is enforced with a
  // 403. It was in the config and in the enforcement, and nowhere in the snapshot,
  // so the console could show the spend but not the reason a request was refused.
  const config = { apiKeys: [{ name: 'pinned', key_hash: 'x'.repeat(64), forcedModel: 'cheap', rateLimit: { rpm: 30 } }] };
  const [tenant] = tenantSnapshot({ config, ledger: ledgerOf([]) });
  assert.equal(tenant.forcedModel, 'cheap');
  assert.equal(tenant.rateLimit.rpm, 30);
});

test('a key with no pin says null rather than an empty string', () => {
  const config = { apiKeys: [{ name: 'free', key_hash: 'x'.repeat(64) }] };
  const [tenant] = tenantSnapshot({ config, ledger: ledgerOf([]) });
  assert.equal(tenant.forcedModel, null, 'a caller that may choose any model must read as null');
});

test('/api/tenants reports the pin and the rate a refusal would cite', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'team-a', key_hash: hashApiKey('sk-a'), dailyUsd: 2, rateLimit: { rpm: 60 }, forcedModel: 'chain' }];
  const { gw, base } = await bootTenants(config);

  const json = await (await fetch(`${base}/api/tenants`)).json();
  const tenant = json.tenants[0];
  assert.equal(tenant.forcedModel, 'chain', 'the pin must reach the page');
  assert.equal(tenant.rateLimit.rpm, 60, 'so must the rate');
  assert.equal(JSON.stringify(json).includes('sk-a'), false, 'and never the key itself');
  await gw.close();
});
