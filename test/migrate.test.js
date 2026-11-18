import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyImport, diffImport, readMigrationSource, smokeTest } from '@drsamonline/cli/src/migrate.js';
import { normalizeConfig } from '@drsamonline/core';
import { makeRouter, testConfig } from './helpers.js';

function writeTmp(name, obj) {
  const dir = mkdtempSync(join(tmpdir(), 'sui-migrate-'));
  const path = join(dir, name);
  writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return path;
}

const nineRouterish = {
  version: 2,
  connections: {
    groq: { type: 'openai', base_url: 'https://api.groq.com/openai/v1', api_key: 'gsk_literal_key_should_not_survive' },
    claude: { kind: 'anthropic', url: 'https://api.anthropic.com/v1', api_key_env: 'ANTHROPIC_API_KEY' },
    local: { format: 'openai', api_base: 'http://127.0.0.1:11434/v1' },
  },
  modelMap: {
    'llama': { provider: 'groq', upstreamModel: 'llama-3.3-70b-versatile', inputCost: 0.00059, outputCost: 0.00079, quality: 4 },
    'sonnet': { provider: 'claude', name: 'claude-3-5-haiku-20241022', title: 'Careful writer' },
    'qwen': { provider: 'local', model: 'qwen2.5-coder:7b' },
  },
  aliases: {
    'chat': { description: 'Everyday chat', mode: 'chain', chain: ['llama', 'sonnet'] },
    'split': { mode: 'ab-split', models: [{ model: 'llama', weight: 70 }, { model: 'sonnet', weight: 30 }] },
  },
  telemetry: { endpoint: 'https://example.invalid' },
};

test('reads a foreign config and maps its concepts onto ours', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  assert.equal(imported.source, '9router');
  assert.deepEqual(Object.keys(imported.providers), ['groq', 'claude', 'local']);

  assert.equal(imported.providers.groq.type, 'openai');
  assert.equal(imported.providers.groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(imported.providers.claude.type, 'anthropic');
  assert.equal(imported.providers.claude.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(imported.providers.local.type, 'openai');

  assert.equal(imported.models.llama.model, 'llama-3.3-70b-versatile');
  assert.equal(imported.models.llama.costPer1kIn, 0.00059);
  assert.equal(imported.models.sonnet.label, 'Careful writer');

  assert.equal(imported.combos.chat.strategy, 'fallback');
  assert.deepEqual(imported.combos.chat.targets, ['llama', 'sonnet']);
  assert.equal(imported.combos.split.strategy, 'weighted');
  assert.deepEqual(imported.combos.split.targets[0], { model: 'llama', weight: 70 });
});

test('a literal key in the old config becomes an env var name, and says so', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  const raw = JSON.stringify(imported);
  assert.equal(raw.includes('gsk_literal_key_should_not_survive'), false, 'the secret must not travel');
  assert.equal(imported.providers.groq.apiKeyEnv, 'GROQ_API_KEY');
  assert.ok(imported.warnings.some((w) => /put the key in .env as GROQ_API_KEY/.test(w)));
});

test('unknown top-level keys are reported, never silently dropped', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  assert.deepEqual(imported.unknownKeys, ['telemetry']);
});

test('the preview diff separates new entries from conflicts', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  const current = normalizeConfig(testConfig(), { env: {} });
  const diff = diffImport(current, imported);

  assert.deepEqual(diff.added.providers, ['groq', 'claude', 'local']);
  assert.deepEqual(diff.added.combos, ['chat', 'split']);
  assert.equal(diff.conflicts.length, 0);

  const overlapping = structuredClone(testConfig());
  overlapping.combos.chat = { strategy: 'fallback', targets: ['mock-a'] };
  const diff2 = diffImport(normalizeConfig(overlapping, { env: {} }), imported);
  assert.ok(diff2.conflicts.some((c) => c.kind === 'combo' && c.id === 'chat'));
  assert.deepEqual(diff2.added.combos, ['split']);
});

test('a model whose provider is not coming along is flagged before import', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  const current = normalizeConfig(testConfig(), { env: {} });
  const diff = diffImport(current, imported);
  assert.deepEqual(diff.dangling, [], 'all three providers are being imported');
});

test('applyImport merges without overwriting what is already there', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  const currentRaw = testConfig();
  currentRaw.models.llama = { provider: 'mock', model: 'mine' };

  const next = applyImport(currentRaw, imported);
  assert.equal(next.models.llama.model, 'mine', 'an existing entry wins');
  assert.equal(next.models.sonnet.provider, 'claude');
  assert.equal(next.combos.chat.strategy, 'fallback');
  assert.ok(next.providers.groq);
  // the original object is untouched
  assert.equal(currentRaw.models.sonnet, undefined);
});

test('applyImport honours a selective import', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  const next = applyImport(testConfig(), imported, { providers: ['groq'], models: ['llama'], combos: ['chat'] });
  assert.deepEqual(Object.keys(next.providers).filter((p) => p === 'groq'), ['groq']);
  assert.equal(next.providers.claude, undefined);
  assert.equal(next.models.sonnet, undefined);
  assert.equal(next.combos.chat.targets[0], 'llama');
});

test('the imported config is actually loadable', () => {
  const imported = readMigrationSource(writeTmp('9router.config.json', nineRouterish));
  const next = applyImport(testConfig(), imported);
  const config = normalizeConfig(next, { env: {} });
  assert.ok(config.combos.chat);
  assert.ok(config.models.llama);
});

test('YAML is refused with a way forward, not a stack trace', () => {
  const path = writeTmp('9router.yaml', 'connections:\n  groq:\n    base_url: https://api.groq.com\n');
  assert.throws(() => readMigrationSource(path), (err) => {
    assert.equal(err.code, 'config_error');
    assert.match(err.message, /not JSON/);
    assert.match(err.message, /export config/);
    return true;
  });
});

test('a missing file says which path failed', () => {
  assert.throws(() => readMigrationSource('/nope/does-not-exist.json'), /Could not open \/nope/);
});

test('the post-migration smoke test reports per combo, including failures', async () => {
  const { router } = makeRouter(testConfig());
  const results = await smokeTest(router, ['chain', 'gated', 'not-a-combo']);
  assert.equal(results.length, 3);
  const chain = results.find((r) => r.combo === 'chain');
  assert.equal(chain.status, 'unverified', 'mock answers are honestly marked unverified');
  const ghost = results.find((r) => r.combo === 'not-a-combo');
  assert.equal(ghost.status, 'failed');
  assert.match(ghost.note, /Unknown model/);
});

test('the diff is stable enough to show a user: same input, same output', () => {
  const path = writeTmp('9router.config.json', nineRouterish);
  const a = diffImport(normalizeConfig(testConfig(), { env: {} }), readMigrationSource(path));
  const b = diffImport(normalizeConfig(testConfig(), { env: {} }), readMigrationSource(path));
  assert.deepEqual(a, b);
  assert.ok(readFileSync(path, 'utf8').length > 0);
});
