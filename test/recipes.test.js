import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyRecipe, describeRecipe } from '@drsamonline/core';

const RECIPE_DIR = join(process.cwd(), 'recipes');
const load = (name) => JSON.parse(readFileSync(join(RECIPE_DIR, `${name}.json`), 'utf8'));

const baseConfig = () => ({
  providers: { demo: { type: 'mock' } },
  models: { 'demo-model': { provider: 'demo', model: 'demo' } },
  combos: { 'chat-default': { strategy: 'fallback', targets: ['demo-model'] } },
  budgets: { dailyUsd: 5 },
  env: {},
});

test('every shipped recipe is valid JSON with the fields the applier reads', () => {
  const files = readdirSync(RECIPE_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5, 'the shipped set should cover the common setups');
  for (const file of files) {
    const recipe = JSON.parse(readFileSync(join(RECIPE_DIR, file), 'utf8'));
    assert.equal(typeof recipe.name, 'string', `${file} needs a name`);
    assert.equal(typeof recipe.title, 'string');
    assert.ok(recipe.description.length > 20, `${file} needs a description worth reading`);
    assert.equal(typeof recipe.patch, 'object', `${file} needs a patch`);
  }
});

test('applying adds what is missing and keeps what is there', () => {
  const result = applyRecipe(baseConfig(), load('free-tier-stack'));
  assert.ok(result.changes.some((c) => c.path === 'providers.groq'));
  assert.ok(result.config.providers.demo, 'an existing provider survives');
  assert.ok(result.config.combos['chat-default'], 'an existing combo survives');
  assert.equal(result.config.combos['free-default'].targets.length, 2);
});

test('applying twice is a no-op', () => {
  const once = applyRecipe(baseConfig(), load('free-tier-stack'));
  const twice = applyRecipe(once.config, load('free-tier-stack'));
  assert.equal(twice.changes.length, 0, 'nothing changed the second time');
  assert.equal(twice.conflicts.length, once.changes.length, 'and every skipped item says why');
});

test('a conflict is reported, not silently overwritten', () => {
  const config = baseConfig();
  config.providers.groq = { type: 'openai', baseUrl: 'https://my-own-proxy.example/v1' };
  const result = applyRecipe(config, load('free-tier-stack'));

  assert.equal(result.config.providers.groq.baseUrl, 'https://my-own-proxy.example/v1', 'the operator wins');
  assert.ok(result.conflicts.some((c) => c.path === 'providers.groq' && /already exists/.test(c.reason)));
});

test('--force replaces, and says it did', () => {
  const config = baseConfig();
  config.providers.groq = { type: 'openai', baseUrl: 'https://my-own-proxy.example/v1' };
  const result = applyRecipe(config, load('free-tier-stack'), { force: true });
  assert.equal(result.config.providers.groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.ok(result.changes.some((c) => c.path === 'providers.groq' && c.action === 'replaced'));
});

test('settings are only set when absent, so a decision already made stands', () => {
  const config = baseConfig();
  config.budgets = { dailyUsd: 20 };
  const result = applyRecipe(config, load('free-tier-stack'));
  assert.equal(result.config.budgets.dailyUsd, 20, 'the existing budget is kept');
  assert.ok(result.conflicts.some((c) => c.path === 'budgets.dailyUsd'));
});

test('a missing env var is reported before anything is applied', () => {
  const result = applyRecipe(baseConfig(), load('free-tier-stack'));
  assert.ok(result.missingEnv.includes('GROQ_API_KEY'));
  assert.ok(result.missingEnv.includes('GEMINI_API_KEY'));
});

test('the privacy recipe sets the tier it promises', () => {
  const result = applyRecipe(baseConfig(), load('privacy-strict'));
  assert.equal(result.config.privacy.defaultTier, 'strict');
  assert.equal(result.config.verification.grounding, 'block');
});

test('the local-only recipe closes the paid gate', () => {
  const result = applyRecipe(baseConfig(), load('local-only'));
  assert.equal(result.config.paidTiers.enabled, false);
  assert.equal(result.config.providers.local.region, 'in');
});

test('applying does not mutate the config it was given', () => {
  const config = baseConfig();
  const before = JSON.stringify(config);
  applyRecipe(config, load('coding'));
  assert.equal(JSON.stringify(config), before, 'a dry run must be able to trust this');
});

test('the summary says what the recipe adds', () => {
  assert.match(describeRecipe(load('free-tier-stack')), /adds 2 provider\(s\), 2 model\(s\), 1 combo\(s\)/);
});
