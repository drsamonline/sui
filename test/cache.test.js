import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCache } from '@drsamonline/telemetry';
import { makeRouter, testConfig, ask } from './helpers.js';

const value = (text) => ({ text, usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop', meta: { costUsd: 0.001 } });

test('exact tier: the same request returns the same entry and says which tier', () => {
  const cache = new ResponseCache({ ttlMs: 1000 });
  const key = ResponseCache.key({ combo: 'c', messages: [{ role: 'user', content: 'hello' }] });
  cache.set(key, value('hi'), { promptText: 'hello' });

  const hit = cache.get(key, 'hello');
  assert.equal(hit.kind, 'exact');
  assert.equal(hit.value.text, 'hi');
});

test('semantic tier is off by default, and stores no prompt text when off', () => {
  const cache = new ResponseCache({ ttlMs: 1000 });
  const key = ResponseCache.key({ combo: 'c', messages: [{ role: 'user', content: 'reverse a linked list' }] });
  cache.set(key, value('ok'), { promptText: 'reverse a linked list' });

  assert.equal(cache.semanticEnabled, false);
  assert.equal(cache.get('different-key', 'reverse a linked list'), null);
  assert.equal(cache.stats().semanticHits, 0);
});

test('semantic tier: a near-identical prompt hits without an exact key', () => {
  const cache = new ResponseCache({ ttlMs: 60000, semantic: { enabled: true, threshold: 0.98 } });
  const key = ResponseCache.key({ combo: 'c', messages: [{ role: 'user', content: 'reverse a linked list in python' }] });
  cache.set(key, value('def reverse(head): ...'), { promptText: 'reverse a linked list in python' });

  const hit = cache.get('a-key-that-does-not-exist', 'reverse a linked list in python');
  assert.ok(hit, 'a near-identical prompt should hit the semantic tier');
  assert.equal(hit.kind, 'semantic');
  assert.equal(hit.value.text, 'def reverse(head): ...');
  assert.equal(cache.stats().semanticHits, 1);
});

test('semantic tier: an unrelated prompt does not hit', () => {
  const cache = new ResponseCache({ ttlMs: 60000, semantic: { enabled: true, threshold: 0.98 } });
  const key = ResponseCache.key({ combo: 'c', messages: [{ role: 'user', content: 'reverse a linked list' }] });
  cache.set(key, value('x'), { promptText: 'reverse a linked list' });

  assert.equal(cache.get('other', 'summarise these nginx access logs'), null);
});

test('semantic tier: an expired entry cannot be resurrected by similarity', () => {
  let clock = 1000;
  const cache = new ResponseCache({ ttlMs: 10, semantic: { enabled: true, threshold: 0.98 }, now: () => clock });
  const key = ResponseCache.key({ combo: 'c', messages: [{ role: 'user', content: 'reverse a linked list' }] });
  cache.set(key, value('x'), { promptText: 'reverse a linked list' });

  clock += 1000;
  assert.equal(cache.get('other', 'reverse a linked list'), null);
});

test('the router records which tier answered', async () => {
  const config = testConfig();
  config.server = { ...config.server, cache: { enabled: true, ttlMs: 60000, maxEntries: 50, semantic: { enabled: true, threshold: 0.98 } } };
  const { router } = makeRouter(config, { cache: true });

  const first = await router.chat({ combo: 'chain', body: ask('reverse a linked list in python') });
  assert.equal(first.meta.cached, false);

  const second = await router.chat({ combo: 'chain', body: ask('reverse a linked list in python') });
  assert.equal(second.meta.cached, true);
  assert.equal(second.meta.cacheKind, 'exact');

  // a different request body (so no exact key) but the same prompt text
  const third = await router.chat({ combo: 'chain', body: { ...ask('reverse a linked list in python'), temperature: 0.2 } });
  assert.equal(third.meta.cached, true, 'the semantic tier should catch it');
  assert.equal(third.meta.cacheKind, 'semantic');
});

/* ------------------------------------------------- B4.7 the embedding tier */

test('the hashing embedding separates near-duplicates from unrelated prompts', async () => {
  const { embed, cosine } = await import('@drsamonline/telemetry/src/embedding.js');
  const a = embed('what does a circuit breaker do in a gateway');
  assert.ok(cosine(a, embed('what does a circuit breaker do in a gateway?')) > 0.99);
  assert.ok(cosine(a, embed('explain what a circuit breaker does in a gateway')) > 0.8);
  assert.ok(cosine(a, embed('how do I bake sourdough bread')) < 0.4);
});

test('the embedding tier hits a near-duplicate and ignores an unrelated prompt', () => {
  const cache = new ResponseCache({ semantic: { enabled: true, tier: 'embedding' }, semanticThreshold: 0.9, now: () => 1000 });
  const prompt = 'summarise the health check handler for the load balancer';
  cache.set('k1', value('summary'), { promptText: prompt });

  const near = cache.get('nope', 'summarise the health check handler for the load balancer please');
  assert.ok(near, 'a near-duplicate should hit');
  assert.equal(near.kind, 'embedding');
  assert.ok(near.score >= 0.9);

  assert.equal(cache.get('nope2', 'how do I configure nginx upstreams'), null);
});

test('the embedding tier still respects expiry', () => {
  let clock = 1000;
  const cache = new ResponseCache({ semantic: { enabled: true, tier: 'embedding' }, semanticThreshold: 0.9, ttlMs: 5000, now: () => clock });
  cache.set('k1', value('summary'), { promptText: 'summarise the health check handler' });
  clock += 6000;
  assert.equal(cache.get('nope', 'summarise the health check handler'), null);
});
