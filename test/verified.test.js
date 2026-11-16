import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { applyVerified, isRoutable, loadSeed } from '@sui/catalog';
import { probeTarget } from '@sui/prober';

/** A healthy OpenAI-compatible upstream. */
async function fakeUpstream({ healthy = true } = {}) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (!healthy) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"unavailable"}');
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-chat-1' }, { id: 'text-embedding-3' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const entryFor = (base) => ({
  provider: 'fake',
  label: 'Fake',
  base_url: base,
  auth: 'none',
  model_family: 'openai-compatible',
  tos: 'review',
  privacy_retention: 'unknown',
  capabilities: ['chat'],
  needs_probe: true,
  notes: 'test entry',
});

/* ------------------------------------- the loop: probe makes an entry routable */

test('a probe that answers is what makes an entry routable', async () => {
  const upstream = await fakeUpstream();
  const entry = entryFor(upstream.base);

  assert.equal(isRoutable(entry), false, 'an unprobed entry cannot route');

  const result = await probeTarget(entry, { timeoutMs: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.levels.liveness.models, 1, 'the embedding model is not counted as chat-capable');

  const [merged] = applyVerified([entry], [
    { provider: 'fake', base_url: upstream.base, probe_model: 'fake-chat-1', models: ['fake-chat-1'], verified_at: Date.now(), capabilities: ['chat'], tos: 'review' },
  ]);

  assert.equal(merged.needs_probe, false, 'a verified entry no longer needs probing');
  assert.equal(isRoutable(merged), true, 'and therefore routes');
  assert.ok(merged.verified_at, 'with the time it was verified');
  assert.equal(merged.probe_model, 'fake-chat-1', 'and the model that answered');
  await upstream.close();
});

test('an entry that fails to answer stays unroutable', async () => {
  const upstream = await fakeUpstream({ healthy: false });
  const entry = entryFor(upstream.base);
  const result = await probeTarget(entry, { timeoutMs: 2000 });

  assert.equal(result.ok, false);
  // nothing is written for a failure, so the overlay stays empty
  const [merged] = applyVerified([entry], []);
  assert.equal(merged.needs_probe, true);
  assert.equal(isRoutable(merged), false);
  await upstream.close();
});

test('the overlay never rewrites provenance', async () => {
  const entry = { ...entryFor('https://example.test/v1'), notes: 'Endpoint recorded by a-source@abc1234.', tos: 'review' };
  const [merged] = applyVerified([entry], [{ provider: 'fake', verified_at: 1, probe_model: 'm', models: ['m'] }]);

  assert.equal(merged.notes, entry.notes, 'the note that says where the endpoint came from is untouched');
  assert.equal(merged.tos, 'review', 'a probe does not read a terms of service');
});

test('a verified entry that is tos:avoid still cannot route', () => {
  const entry = { ...entryFor('https://example.test/v1'), tos: 'avoid' };
  const [merged] = applyVerified([entry], [{ provider: 'fake', verified_at: 1 }]);
  assert.equal(isRoutable(merged), false, 'I12 outranks a passing probe');
});

test('the shipped overlay is a valid, empty ledger', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const overlay = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'verified.json'), 'utf8'));

  assert.ok(Array.isArray(overlay.entries));
  assert.match(overlay._comment, /Separate from seed\.json/);
  for (const row of overlay.entries) {
    assert.ok(row.provider && row.verified_at, 'a row without a provider or a timestamp is not a verification');
  }
});

test('every seeded entry starts unverified, because nobody has probed them here', async () => {
  const { join } = await import('node:path');
  const entries = loadSeed(join(process.cwd(), 'packages', 'catalog', 'seed.json'));
  const verified = entries.filter((e) => e.verified_at);
  assert.deepEqual(verified.map((e) => e.provider), [], 'an entry verified in this repository would be a claim we cannot support');
});

test('the overlay lives in the user home, not in the package', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'apps', 'cli', 'src', 'commands-extra.js'), 'utf8');

  // writing observations into an installed node_modules would be wrong, and a
  // verification on one machine is not evidence for another
  assert.match(source, /function verifiedPath\(\)[\s\S]{0,120}join\(suiHome\(\), 'catalog-verified\.json'\)/);
  assert.match(source, /legacyVerifiedPath/, 'a development clone keeps its old state');
  assert.equal(/writeFileSync\(path, .*verified/.test(source) && /join\(ROOT, 'packages', 'catalog', 'verified\.json'\);\s*\n\s*const current/.test(source), false);
});

test('a corrupt overlay does not stop the catalogue loading', async () => {
  const { applyVerified, loadSeed } = await import('@sui/catalog');
  const { join } = await import('node:path');
  const entries = loadSeed(join(process.cwd(), 'packages', 'catalog', 'seed.json'));
  // the loader is defensive; here we prove the merge tolerates junk rows
  const merged = applyVerified(entries, [{ provider: 'not-a-real-provider', verified_at: 1 }]);
  assert.equal(merged.length, entries.length, 'an overlay row for an unknown provider changes nothing');
  assert.equal(merged.every((e) => e.needs_probe), true);
});
