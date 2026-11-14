import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeEntries, isRoutable, normalizeEntry, poolKey, scoreEntry, summarise, loadSeed } from '@sui/catalog';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

test('an unknown ToS posture defaults to review, never allowed', () => {
  const entry = normalizeEntry({ provider: 'mystery', base_url: 'https://x.example/v1' });
  assert.equal(entry.tos, 'review');
  assert.equal(entry.privacy_retention, 'unknown');
});

test('dedupe collapses the same upstream behind two names', () => {
  const entries = dedupeEntries([
    { provider: 'a', base_url: 'https://api.example.com/v1', model_family: 'llama', tos: 'review' },
    { provider: 'b', base_url: 'https://api.example.com/v1', model_family: 'llama', tos: 'allowed' },
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].aliases, ['a', 'b']);
  assert.equal(entries[0].tos, 'allowed', 'the better posture wins');
});

test('pool_key ignores a trailing slash and differs by model family', () => {
  const a = poolKey(normalizeEntry({ provider: 'a', base_url: 'https://api.example.com/v1/', model_family: 'llama' }));
  const b = poolKey(normalizeEntry({ provider: 'b', base_url: 'https://api.example.com/v1', model_family: 'llama' }));
  const c = poolKey(normalizeEntry({ provider: 'c', base_url: 'https://api.example.com/v1', model_family: 'qwen' }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('nothing is routable before it is probed', () => {
  const unprobed = normalizeEntry({ provider: 'x', base_url: 'https://x.example/v1', needs_probe: true });
  assert.equal(isRoutable(unprobed), false);

  const probed = { ...unprobed, needs_probe: false };
  assert.equal(isRoutable(probed), true);
});

test('a tos:avoid entry is never routable, probed or not', () => {
  const entry = { ...normalizeEntry({ provider: 'x', base_url: 'https://x.example/v1' }), needs_probe: false, tos: 'avoid' };
  assert.equal(isRoutable(entry), false);
});

test('an identity with no URL is not routable, however healthy it sounds', () => {
  const identity = normalizeEntry({ provider: 'pollinations', auth: 'none' });
  assert.equal(identity.base_url, null);
  assert.equal(identity.needs_probe, true);
  assert.equal(isRoutable(identity), false);
});

test('scoring: a dead probe scores zero and a fast healthy one scores higher', () => {
  const entry = { ...normalizeEntry({ provider: 'x', base_url: 'https://x.example/v1' }), needs_probe: false, tos: 'allowed', privacy_retention: 'none' };
  const dead = scoreEntry(entry, { probe: { ok: false, latencyMs: 10 } });
  const alive = scoreEntry(entry, { probe: { ok: true, latencyMs: 200 } });
  const slow = scoreEntry(entry, { probe: { ok: true, latencyMs: 3900 } });

  assert.equal(dead.routable, false);
  assert.equal(alive.routable, true);
  assert.ok(alive.score > slow.score, 'latency must move the score');
  assert.ok(alive.score > 0 && alive.score <= 1);
});

test('scoring: tos:avoid cannot be rescued by a perfect probe', () => {
  const entry = { ...normalizeEntry({ provider: 'x', base_url: 'https://x.example/v1' }), needs_probe: false, tos: 'avoid' };
  const scored = scoreEntry(entry, { probe: { ok: true, latencyMs: 10 }, quality: 5 });
  assert.equal(scored.routable, false);
});

test('the shipped seed loads, and every entry is honest about being unprobed', () => {
  const seed = loadSeed(join(HERE, '..', 'packages', 'catalog', 'seed.json'));
  assert.ok(seed.length >= 8, 'the seed should cover the keyless and keyed providers named in the spec');
  assert.ok(seed.some((e) => e.provider === 'pollinations' && e.auth === 'none'));
  assert.ok(seed.every((e) => e.needs_probe === true), 'nothing ships pre-verified');
  const summary = summarise(seed);
  assert.equal(summary.routable, 0, 'a fresh install has no verified route yet — that is the point');
  assert.equal(summary.awaiting_probe, seed.length);
});
