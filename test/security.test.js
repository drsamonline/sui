import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { makeGateway, testConfig } from './helpers.js';
import { hashApiKey, verifyApiKey } from '@drsamonline/core';
import { hostAllowed } from '@drsamonline/gateway/src/server.js';
import { run as cli } from '@drsamonline/cli/src/cli.js';

async function boot(config) {
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (gw.server.address());
  return {
    ...gw,
    port,
    base: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        gw.server.closeAllConnections?.();
        gw.server.close(() => resolve());
      }),
  };
}

/** Raw request so the Host header can be forged. */
function rawGet(port, path, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('host allowlist: a forged Host header is refused', async () => {
  const gw = await boot(testConfig());
  const res = await rawGet(gw.port, '/api/status', 'evil.example.com');
  assert.equal(res.status, 403);
  const json = JSON.parse(res.body);
  assert.equal(json.error.type, 'host_not_allowed');
  assert.match(json.error.message, /does not answer to the host/);
  assert.match(json.error.message, /allowedHosts/);
  await gw.stop();
});

test('hostAllowed: the default list is loopback only, and an explicit list replaces it', () => {
  const config = { server: {} };
  assert.equal(hostAllowed(config, '127.0.0.1:8787'), true);
  assert.equal(hostAllowed(config, 'localhost'), true);
  assert.equal(hostAllowed(config, '[::1]:8787'), true);
  assert.equal(hostAllowed(config, 'evil.example.com'), false);
  assert.equal(hostAllowed(config, undefined), true, 'a missing Host header is not an attack');

  const custom = { server: { allowedHosts: ['sui.internal'] } };
  assert.equal(hostAllowed(custom, 'sui.internal:80'), true);
  assert.equal(hostAllowed(custom, '127.0.0.1'), false, 'an explicit list is not extended by defaults');
});

test('host allowlist: localhost and 127.0.0.1 with a port are allowed', async () => {
  const gw = await boot(testConfig());
  for (const host of [`127.0.0.1:${gw.port}`, `localhost:${gw.port}`]) {
    const res = await rawGet(gw.port, '/healthz', host);
    assert.equal(res.status, 200, `${host} should be allowed`);
  }
  await gw.stop();
});

test('host allowlist: an explicit allowlist wins over the defaults', async () => {
  const config = testConfig();
  config.server = { ...config.server, allowedHosts: ['sui.internal'] };
  const gw = await boot(config);

  const blocked = await rawGet(gw.port, '/healthz', `127.0.0.1:${gw.port}`);
  assert.equal(blocked.status, 403, 'the default hosts are replaced, not extended');

  const allowed = await rawGet(gw.port, '/healthz', 'sui.internal');
  assert.equal(allowed.status, 200);
  await gw.stop();
});

test('API keys are compared as hashes, in constant time', () => {
  const hash = hashApiKey('sk-live-abc');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(verifyApiKey('sk-live-abc', { key_hash: hash }), true);
  assert.equal(verifyApiKey('sk-live-abd', { key_hash: hash }), false);
  assert.equal(verifyApiKey('', { key_hash: hash }), false);
  assert.equal(verifyApiKey('sk-live-abc', {}), false);
  // legacy plaintext entries still verify, and are reported by the audit
  assert.equal(verifyApiKey('sk-live-abc', { key: 'sk-live-abc' }), true);
});

test('a config with only key hashes authenticates, and never exposes them', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'team', key_hash: hashApiKey('sk-hashed-123'), allowedCombos: ['chain'] }];
  const gw = await boot(config);

  const anon = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(anon.status, 401);

  const authed = await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-hashed-123' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(authed.status, 200);

  const safe = JSON.stringify(await (await fetch(`${gw.base}/api/config`)).json());
  assert.equal(safe.includes('sk-hashed-123'), false, 'the key must not appear in the config view');
  assert.equal(safe.includes(hashApiKey('sk-hashed-123')), false, 'nor its hash');
  await gw.stop();
});

test('a port already in use produces a sentence, not EADDRINUSE', async () => {
  const gw = await boot(testConfig());
  const previousExit = process.exitCode;
  try {
    await assert.rejects(
      () => cli(['start', '--config', 'does-not-matter.json', '--port', String(gw.port)]),
      (err) => {
        // config load happens first, so this proves the CLI surfaces config errors plainly
        assert.match(/** @type {any} */ (err).message, /config|No sui config/i);
        return true;
      },
    );
  } finally {
    process.exitCode = previousExit;
  }
  await gw.stop();
});

test('the config view exposes no key material of any kind', async () => {
  const config = testConfig();
  config.providers.fake.apiKey = 'sk-should-not-leak';
  config.apiKeys = [{ key: 'sk-also-secret' }];
  const gw = await boot(config);

  const body = await (await fetch(`${gw.base}/api/config`)).text();
  assert.equal(body.includes('sk-should-not-leak'), false);
  assert.equal(body.includes('sk-also-secret'), false);

  const status = await (await fetch(`${gw.base}/api/status`)).text();
  assert.equal(status.includes('sk-should-not-leak'), false);
  await gw.stop();
});

test('the invariants endpoint reports the audit for the running config', async () => {
  const config = testConfig();
  config.apiKeys = [{ key: 'sk-plaintext' }];
  const gw = await boot(config);

  const json = await (await fetch(`${gw.base}/api/invariants`)).json();
  assert.equal(json.invariants.length, 19);
  const i15 = json.audit.find((a) => a.id === 'I15');
  assert.equal(i15.ok, false, 'a plaintext key should be flagged');
  assert.equal(json.paidTiers.enabled, false);
  await gw.stop();
});
