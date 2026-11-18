import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, openVaultForStartup } from '@drsamonline/vault';
import { providerHasCredentials } from '@drsamonline/core';
import { makeGateway } from './helpers.js';

function tmpVault() {
  const dir = mkdtempSync(join(tmpdir(), 'sui-vault-'));
  return { dir, path: join(dir, 'vault.json'), keyPath: join(dir, 'vault.key') };
}

test('a fresh vault is created with a 0600 key file and opens empty', async () => {
  const { path, keyPath } = tmpVault();
  const vault = createVault({ path, keyPath, env: {} });
  const created = await vault.init();
  assert.equal(created.created, true);
  assert.equal(created.keyPath, keyPath);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600, 'the passphrase file must not be world-readable');
  assert.deepEqual(await vault.read(), {});
});

test('set, read and remove round-trip, and the key never lands in the file', async () => {
  const { path, keyPath } = tmpVault();
  const vault = createVault({ path, keyPath, env: {} });
  await vault.init();
  await vault.set('openai', 'sk-super-secret-value');

  const onDisk = readFileSync(path, 'utf8');
  assert.equal(onDisk.includes('sk-super-secret-value'), false, 'the vault file must not contain the key');
  assert.equal(onDisk.includes('openai'), false, 'even provider names stay inside the envelope');

  assert.deepEqual(await vault.list(), ['openai']);
  assert.equal((await vault.read()).openai, 'sk-super-secret-value');

  assert.equal(await vault.remove('openai'), true);
  assert.equal(await vault.remove('openai'), false);
  assert.deepEqual(await vault.list(), []);
});

test('an explicit passphrase skips the key file entirely', async () => {
  const { path, keyPath } = tmpVault();
  const vault = createVault({ path, keyPath, env: { SUI_VAULT_PASSPHRASE: 'from-the-environment' } });
  const created = await vault.init();
  assert.equal(created.keyPath, null, 'no key file should be written');
  await vault.set('groq', 'gsk-x');

  const reopened = createVault({ path, keyPath, env: { SUI_VAULT_PASSPHRASE: 'from-the-environment' } });
  assert.equal((await reopened.read()).groq, 'gsk-x');

  const wrong = createVault({ path, keyPath, env: { SUI_VAULT_PASSPHRASE: 'not-the-passphrase' } });
  await assert.rejects(() => wrong.read(), /passphrase does not match/);
});

test('a missing passphrase refuses to guess', async () => {
  const { path, keyPath } = tmpVault();
  const vault = createVault({ path, keyPath, env: {} });
  await vault.init();
  // simulate the key file being lost
  writeFileSync(keyPath, '');
  const broken = createVault({ path, keyPath, env: {} });
  await assert.rejects(() => broken.read(), /passphrase does not match|no passphrase/i);
});

test('startup never throws on a locked vault — it reports a reason', async () => {
  const { path, keyPath } = tmpVault();
  const opened = await openVaultForStartup({ path, keyPath, env: {} });
  assert.deepEqual(opened.keys, {});
  assert.match(opened.reason, /no vault file/);
});

test('I4 + B6.7: with the gate closed the vault is not opened and the key is not loaded', async () => {
  const { dir, path, keyPath } = tmpVault();
  const vault = createVault({ path, keyPath, env: {} });
  await vault.init();
  await vault.set('paidco', 'sk-vault-key');

  const config = {
    server: { host: '127.0.0.1', port: 0, cache: { enabled: false } },
    providers: { paidco: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'PAIDCO_KEY', tier: 'paid' } },
    models: { 'paid-model': { provider: 'paidco', model: 'm', costPer1kIn: 1, costPer1kOut: 1, quality: 5, tier: 'paid' } },
    combos: { 'chat-default': { strategy: 'fallback', targets: ['paid-model'] } },
    breaker: { failures: 2, cooldownMs: 1000 },
    budgets: { dailyUsd: null, perProvider: {} },
    guardrails: { maxOutputTokens: 128, maxInputChars: 10000, blockPatterns: [], logPrompts: false },
    paid_tiers: { enabled: false, vaultPath: path },
    apiKeys: [],
  };
  const gw = await makeGateway(config);
  assert.equal(gw.env.PAIDCO_KEY, undefined, 'the key must not be injected while the gate is closed');
  assert.equal(providerHasCredentials(gw.config.providers.paidco, gw.env, gw.config), false);
  assert.match(gw.config.vault.reason, /paid tier is closed/);
  assert.deepEqual(gw.config.vault.providers, []);
  void dir;
});

test('B6.7: with the gate open the sealed key is loaded and the provider becomes usable', async () => {
  const { path, keyPath } = tmpVault();
  const vault = createVault({ path, keyPath, env: {} });
  await vault.init();
  await vault.set('paidco', 'sk-vault-key');

  const config = {
    server: { host: '127.0.0.1', port: 0, cache: { enabled: false } },
    providers: { paidco: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'PAIDCO_KEY', tier: 'paid' } },
    models: { 'paid-model': { provider: 'paidco', model: 'm', costPer1kIn: 1, costPer1kOut: 1, quality: 5, tier: 'paid' } },
    combos: { 'chat-default': { strategy: 'fallback', targets: ['paid-model'] } },
    breaker: { failures: 2, cooldownMs: 1000 },
    budgets: { dailyUsd: null, perProvider: {} },
    guardrails: { maxOutputTokens: 128, maxInputChars: 10000, blockPatterns: [], logPrompts: false },
    paid_tiers: { enabled: true, vaultPath: path },
    apiKeys: [],
  };
  const gw = await makeGateway(config);
  assert.equal(gw.env.PAIDCO_KEY, 'sk-vault-key');
  assert.equal(providerHasCredentials(gw.config.providers.paidco, gw.env, gw.config), true);
  assert.deepEqual(gw.config.vault.providers, ['paidco']);
});
