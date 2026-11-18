import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrompt } from '@drsamonline/router';
import { makeRouter, testConfig, ask } from './helpers.js';

/* ------------------------------------------------------ the classifier */

test('a short lookup is simple, a task is not', () => {
  assert.equal(classifyPrompt('what is the capital of France?').complexity, 'simple');
  assert.equal(classifyPrompt('how many items are in the cart?').complexity, 'simple');
  assert.equal(classifyPrompt('write a function that debounces another function').complexity, 'complex');
  assert.equal(classifyPrompt('why does this query return two rows?').complexity, 'complex');
});

test('code, schemas and multi-step instructions are complex, with the signal named', () => {
  const code = classifyPrompt('```js\nconst a = 1;\n```\nwhat does this do?');
  assert.equal(code.complexity, 'complex');
  assert.ok(code.signals.includes('code'));

  const schema = classifyPrompt('return this as json with keys name and age');
  assert.ok(schema.signals.includes('schema'));

  const steps = classifyPrompt('First read the config, then validate it, and finally reload.');
  assert.equal(steps.complexity, 'complex');
  assert.ok(steps.signals.some((s) => s.startsWith('multi-step')));
});

test('a long prompt is complex on length alone', () => {
  const long = `summarise this: ${'word '.repeat(200)}`;
  const result = classifyPrompt(long);
  assert.equal(result.complexity, 'complex');
  assert.ok(result.signals.some((s) => s.startsWith('long prompt')));
});

test('the classifier answers well inside 50ms even on a huge prompt', () => {
  const huge = `explain ${'word '.repeat(20000)}`;
  // Best of three, warmed up: a single wall-clock reading in a test process that
  // shares a CPU with thirty other test files measures the machine's mood, not
  // the classifier. It failed at 52ms once and passed at 3ms the next run.
  classifyPrompt(huge, { maxMs: 50 });
  let best = Infinity;
  for (let i = 0; i < 3; i++) best = Math.min(best, classifyPrompt(huge, { maxMs: 50 }).ms);

  assert.ok(best < 50, `best of three took ${best}ms, budget 50ms`);
  assert.equal(classifyPrompt(huge, { maxMs: 50 }).signals.some((s) => s.includes('budget')), false);
});

/* ------------------------------------------------- the cascade in a combo */

function cascadeConfig() {
  const config = testConfig();
  config.models['cheap-1'] = { provider: 'mock', model: 'cheap', costPer1kIn: 0.0001, costPer1kOut: 0.0002, quality: 2 };
  config.models['strong-1'] = { provider: 'mock', model: 'strong', costPer1kIn: 0.01, costPer1kOut: 0.02, quality: 5 };
  config.providers.mock = { type: 'mock', mock: { delayMs: 1 } };
  config.combos.cascade = {
    strategy: 'fallback',
    targets: ['cheap-1', 'strong-1'],
    cascade: { enabled: true, simple: ['cheap-1'], complex: ['strong-1'] },
  };
  return config;
}

test('a simple prompt goes to the cheap target, and the decision is on the record', async () => {
  const { router } = makeRouter(cascadeConfig());
  const res = await router.chat({ combo: 'cascade', body: ask('what is the capital of France?') });
  assert.equal(res.meta.modelId, 'cheap-1');
  assert.equal(res.meta.route.cascade.complexity, 'simple');
  assert.ok(res.meta.route.cascade.ms < 50);
});

test('a complex prompt goes straight to the strong target', async () => {
  const { router } = makeRouter(cascadeConfig());
  const res = await router.chat({
    combo: 'cascade',
    body: ask('First read the config, then validate it. Write the function and explain the trade-off.'),
  });
  assert.equal(res.meta.modelId, 'strong-1');
  assert.equal(res.meta.route.cascade.complexity, 'complex');
});

test('without a cascade block the combo behaves exactly as declared', async () => {
  const config = cascadeConfig();
  delete config.combos.cascade.cascade;
  const { router } = makeRouter(config);
  const res = await router.chat({ combo: 'cascade', body: ask('what is the capital of France?') });
  assert.equal(res.meta.modelId, 'cheap-1', 'the first declared target, because that is the order');
  assert.equal(res.meta.route.cascade, null);
});

test('a cascade list naming a model that is not in the combo is ignored, not fatal', async () => {
  const config = cascadeConfig();
  config.combos.cascade.cascade.simple = ['ghost-1'];
  const { router } = makeRouter(config);
  const res = await router.chat({ combo: 'cascade', body: ask('what is the capital of France?') });
  assert.equal(res.meta.modelId, 'cheap-1', 'falls back to the declared order rather than failing');
});
