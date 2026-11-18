import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeEntries, isRoutable, normalizeEntry, poolKey, scoreEntry, summarise, loadSeed } from '@drsamonline/catalog';
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

/* ------------------------------------------ the 9router import (B2.5 seed) */

test('every catalogue entry is well formed and could be probed', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { normalizeEntry, poolKey } = await import('@drsamonline/catalog');
  const seed = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8'));

  const keys = new Set();
  for (const raw of seed.entries) {
    const entry = normalizeEntry(raw);
    assert.ok(entry.provider.length > 0);
    assert.ok(['none', 'key'].includes(entry.auth));
    assert.ok(['allowed', 'review', 'avoid'].includes(entry.tos), `${entry.provider} has tos ${entry.tos}`);
    if (entry.base_url) {
      assert.match(entry.base_url, /^https?:\/\//, `${entry.provider} has a malformed base_url`);
      // plain http is only acceptable for something on this machine
      if (entry.base_url.startsWith('http://')) {
        assert.match(entry.base_url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/, `${entry.provider} points at plain http off-loopback`);
      }
    }
    // a keyed provider must say which variable holds the key
    if (entry.auth === 'key') assert.ok(entry.key_env, `${entry.provider} needs a key but names no key_env`);
    const key = poolKey(entry);
    assert.equal(keys.has(key), false, `two entries share the pool key ${key}`);
    keys.add(key);
  }
});

test('an imported endpoint is never marked routable on someone else\'s word', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const seed = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8'));

  const imported = seed.entries.filter((e) => /9router-auto-free@/.test(e.notes ?? ''));
  assert.ok(imported.length >= 8, `expected the import to have landed, found ${imported.length}`);

  for (const entry of imported) {
    assert.equal(entry.needs_probe, true, `${entry.provider} must still be probed`);
    assert.equal(entry.tos, 'review', `${entry.provider} cannot be 'allowed' on the strength of a URL`);
    assert.equal(entry.verified_at ?? null, null, `${entry.provider} was not verified by this gateway`);
  }
});

test('the import is reproducible and does not duplicate on a second run', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const source = join(process.cwd(), '..', '9router');
  if (!existsSync(join(source, 'providers.js'))) {
    // the reference clone is not part of this repository; the seed it produced is
    assert.ok(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8').includes('9router-auto-free@'));
    return;
  }
  const before = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8')).entries.length;
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['scripts/import-9router.mjs', '--source', source], { cwd: process.cwd(), encoding: 'utf8' });
  const after = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8')).entries.length;
  assert.equal(after, before, 'a second import must add nothing');
});

/* -------------------------------------------- the source ledger (B2.2) */

test('every source records its licence and a pinned commit', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ledger = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'sources.json'), 'utf8'));

  assert.ok(ledger.sources.length >= 7, `expected the seven sources, found ${ledger.sources.length}`);
  for (const source of ledger.sources) {
    assert.match(source.url, /^https:\/\/github\.com\//, `${source.id} needs a github url`);
    assert.match(source.commit, /^[0-9a-f]{7}$/, `${source.id} needs a pinned commit, not a branch`);
    assert.ok(source.licence, `${source.id} must say what its licence is`);
    assert.ok(source.taken, `${source.id} must say what was taken`);
    assert.ok(source.notTaken, `${source.id} must say what was not taken`);
    // a source with no declared licence may contribute facts only
    if (/none declared/i.test(source.licence)) {
      assert.match(source.taken, /base URL|fact/i, `${source.id} has no licence, so only facts may be taken`);
      assert.match(source.notTaken, /no code/i);
    }
  }
});

test('every catalogue entry with an endpoint says where it came from', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const seed = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8'));

  const unattributed = seed.entries.filter(
    (e) => e.base_url && !/recorded by|Imported from|verified|spec|local|loopback/i.test(e.notes ?? ''),
  );
  assert.deepEqual(
    unattributed.map((e) => e.provider),
    [],
    'an endpoint with no recorded provenance cannot be audited later',
  );
});

test('the three keyless providers the spec names now have endpoints', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const seed = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8'));

  for (const provider of ['pollinations', 'ovhcloud-ai', 'llm7']) {
    const entry = seed.entries.find((e) => e.provider === provider);
    assert.ok(entry, `${provider} is missing from the catalogue`);
    assert.ok(entry.base_url, `${provider} still has no endpoint`);
    assert.match(entry.base_url, /^https:\/\//, `${provider} endpoint must be https`);
    assert.equal(entry.needs_probe, true, `${provider} must still be probed before it routes`);
    assert.equal(entry.tos, 'review', `${provider} ToS has not been read by anyone here`);
  }
});

/* --------------------------------------- the sync worker (B2.2) */

test('the sync worker finds the ledger and the seed in agreement', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['scripts/sync-catalog.mjs', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
  const report = JSON.parse(out);

  assert.deepEqual(report.problems, [], `the ledger and the seed disagree: ${report.problems.join('; ')}`);
  assert.ok(report.sources.length >= 7);
  for (const source of report.sources) {
    assert.equal(source.status, 'pinned', `${source.id} is not pinned`);
    assert.ok(source.entries > 0 || source.id === 'free-llm-gateway', `${source.id} contributes no entries`);
  }
});

test('the sync worker never rewrites the seed from the network', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const before = readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8');
  const { execFileSync } = await import('node:child_process');
  // offline run: proves the default path touches nothing
  execFileSync(process.execPath, ['scripts/sync-catalog.mjs'], { cwd: process.cwd(), encoding: 'utf8' });
  const after = readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8');
  assert.equal(after, before, 'a sync is a report, not a mutation');
});

/* -------------------------------- the generated catalogue is not padding */

test('the generated catalogue keeps nothing it cannot justify', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const generated = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'generated.json'), 'utf8'));

  // The app-endpoints dataset is a directory of miscellaneous public APIs. Three
  // keyword heuristics produced a sudoku API, a model catalogue and 24 QR-code
  // services. The only defensible rule is an allowlist, which is currently empty.
  assert.deepEqual(
    generated.entries.map((e) => e.provider),
    [],
    'an entry here needs evidence it serves a model, not a keyword match',
  );
  assert.match(generated._comment, /EMPTY by design/);
});

test('the catalogue count is the seeded count, not the seeded count plus filler', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { loadSeed, dedupeEntries } = await import('@drsamonline/catalog');
  const seed = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8'));
  const catalogue = dedupeEntries(loadSeed(join(process.cwd(), 'packages', 'catalog', 'seed.json')));

  assert.equal(catalogue.length, seed.entries.length, 'nothing may be added to the catalogue that is not in the seed');
  assert.ok(catalogue.every((e) => e.provider && e.pool_key), 'every entry carries an identity');
});
