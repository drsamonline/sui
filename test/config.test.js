import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToggle,
  estimatedCost,
  normalizeConfig,
  providerHasCredentials,
  resolveCombo,
  sanitizeConfig,
  validateConfig,
} from '@drsamonline/core';
import { filterConfig } from '@drsamonline/cli/src/onboarding.js';
import { testConfig } from './helpers.js';

const quietEnv = {};

test('a valid config loads and gets sane defaults', () => {
  const config = normalizeConfig(testConfig(), { env: quietEnv });
  assert.equal(config.server.port, 0);
  assert.equal(config.breaker.failures, 2);
  assert.equal(config.guardrails.maxOutputTokens, 256);
  assert.equal(config.budgets.dailyUsd, null);
});

test('a typo in a combo strategy names the field and the allowed values', () => {
  const raw = testConfig();
  raw.combos.chain.strategy = 'fallbak';
  assert.throws(
    () => normalizeConfig(raw, { env: quietEnv }),
    (err) => {
      assert.equal(err.code, 'config_error');
      assert.match(err.message, /combos\.chain\.strategy/);
      assert.match(err.message, /fallback, weighted, cheapest, latency/);
      return true;
    },
  );
});

test('a combo pointing at an undeclared model is caught at load time', () => {
  const raw = testConfig();
  raw.combos.chain.targets = ['fake-a', 'ghost-model'];
  assert.throws(
    () => normalizeConfig(raw, { env: quietEnv }),
    /combos\.chain points at model "ghost-model"/,
  );
});

test('a model pointing at an undeclared provider is caught at load time', () => {
  const raw = testConfig();
  raw.models['orphan'] = { provider: 'nobody', model: 'x' };
  assert.throws(() => normalizeConfig(raw, { env: quietEnv }), /not declared in providers/);
});

test('weighted combos without weights are refused', () => {
  const raw = testConfig();
  raw.combos.weighted.targets = ['mock-a', 'mock-b'];
  assert.throws(() => normalizeConfig(raw, { env: quietEnv }), /have no weights/);
});

test('every problem is listed at once, not one per run', () => {
  const raw = testConfig();
  raw.combos.chain.strategy = 'nope';
  raw.models['mock-a'].provider = 'ghost';
  raw.providers.mock.type = 'carrier-pigeon';
  assert.throws(
    () => normalizeConfig(raw, { env: quietEnv }),
    (err) => {
      assert.match(err.message, /3 problems to fix/);
      return true;
    },
  );
});

test('resolveCombo accepts a bare model id, so strict tools still work', () => {
  const config = normalizeConfig(testConfig(), { env: quietEnv });
  const combo = resolveCombo(config, 'mock-b');
  assert.equal(combo.strategy, 'fallback');
  assert.equal(combo.targets.length, 1);
  assert.equal(combo.targets[0].modelId, 'mock-b');
});

test('resolveCombo on an unknown name lists what does exist', () => {
  const config = normalizeConfig(testConfig(), { env: quietEnv });
  assert.throws(() => resolveCombo(config, 'gpt-9'), /Available: chain, weighted, cheap, gated/);
});

test('cost is computed from the model’s own prices', () => {
  const model = { costPer1kIn: 0.5, costPer1kOut: 1 };
  assert.equal(estimatedCost(model, 1000, 1000), 1.5);
  assert.equal(estimatedCost(model, 0, 0), 0);
  assert.equal(estimatedCost({}, 5000, 5000), 0);
});

test('credentials: mock and keyless endpoints are ready; a missing env var is not', () => {
  assert.equal(providerHasCredentials({ type: 'mock' }), true);
  assert.equal(providerHasCredentials({ type: 'openai', apiKeyEnv: null }), true);
  assert.equal(providerHasCredentials({ type: 'openai', local: true }), true);
  assert.equal(providerHasCredentials({ type: 'openai', apiKeyEnv: 'NOPE_KEY' }, {}), false);
  assert.equal(providerHasCredentials({ type: 'openai', apiKeyEnv: 'YES_KEY' }, { YES_KEY: 'x' }), true);
});

test('sanitised config carries no key material', () => {
  const raw = testConfig();
  raw.providers.fake.apiKey = 'sk-literal-secret';
  const config = normalizeConfig(raw, { env: quietEnv });
  const safe = JSON.stringify(sanitizeConfig(config));
  assert.equal(safe.includes('sk-literal-secret'), false);
  assert.match(safe, /"hasCredentials":true/);
});

test('toggle gate: a provider in use cannot be disabled, and says why', () => {
  const config = normalizeConfig(testConfig(), { env: quietEnv });
  const result = checkToggle(config, { disableProvider: 'mock' });
  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].code, 'provider_in_use');
  assert.match(result.blockers[0].message, /still backs 2 models/);
  assert.match(result.blockers[0].fix, /chain, weighted, cheap/);
});

test('toggle gate: a model still in a combo cannot be disabled', () => {
  const config = normalizeConfig(testConfig(), { env: quietEnv });
  const result = checkToggle(config, { disableModel: 'mock-a' });
  assert.equal(result.ok, false);
  assert.match(result.blockers[0].message, /target of: chain, weighted, cheap, gated/);
});

test('toggle gate: an unused model, and an unknown one, do not block', () => {
  const config = normalizeConfig(testConfig(), { env: quietEnv });
  assert.equal(checkToggle(config, { disableModel: 'never-referenced' }).ok, true);
});

test('toggle gate: enabling a combo that does not exist is blocked', () => {
  const config = normalizeConfig(testConfig(), { env: quietEnv });
  const result = checkToggle(config, { enableCombo: 'ghost' });
  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].code, 'combo_missing');
});

test('first-run filtering keeps only providers we can reach', () => {
  const template = {
    providers: { groq: { type: 'openai', baseUrl: 'x', apiKeyEnv: 'GROQ_API_KEY' }, gemini: { type: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' } },
    models: {
      'groq-70b': { provider: 'groq', model: 'llama' },
      'gemini-flash': { provider: 'gemini', model: 'flash' },
    },
    combos: {
      'chat-default': { strategy: 'fallback', targets: ['groq-70b', 'gemini-flash'] },
      'gemini-only': { strategy: 'fallback', targets: ['gemini-flash'] },
    },
    server: { port: 8787 },
  };
  const filtered = filterConfig(template, ['groq']);
  assert.deepEqual(Object.keys(filtered.providers), ['groq']);
  assert.deepEqual(Object.keys(filtered.models), ['groq-70b']);
  assert.deepEqual(Object.keys(filtered.combos), ['chat-default']);
  assert.deepEqual(filtered.combos['chat-default'].targets, ['groq-70b']);
  assert.equal(validateConfig(normalizeConfig(filtered, { env: {} })), true);
});
