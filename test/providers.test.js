import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeGateway, testConfig } from './helpers.js';
import { catalogueDirs, loadCatalogue, loadProbeTargets } from '../apps/gateway/src/workers.js';
import { readVerifiedOverlay } from '@drsamonline/catalog';

/**
 * The catalogue, on the page.
 *
 * `sui catalog` was the only way to see what this gateway could route to, so the
 * product's central distinction — an identity is not a route — was invisible to
 * anyone who only opened the dashboard. These tests hold the join that makes it
 * visible: the seed (what was imported), the overlay (what a probe observed on
 * this machine) and the prober's snapshot (what this process has seen).
 */

async function bootProviders(env = {}) {
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  return { gw, base: `http://127.0.0.1:${port}` };
}

/** Run a body with SUI_HOME pointed at a fresh directory, then restore it. */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'sui-providers-'));
  const previous = process.env.SUI_HOME;
  process.env.SUI_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.SUI_HOME;
    else process.env.SUI_HOME = previous;
  }
}

test('/api/providers lists the catalogue, and says which entries are routes', async () => {
  const { gw, base } = await bootProviders();
  try {
    const json = await (await fetch(`${base}/api/providers`)).json();
    assert.ok(json.providers.length > 10, 'the shipped catalogue has more than ten entries');
    assert.equal(json.summary.total, json.providers.length);

    const states = new Set(json.providers.map((p) => p.state));
    for (const state of states) {
      assert.ok(['verified', 'awaiting-probe', 'identity'].includes(state), `unexpected state "${state}"`);
    }
    // nothing in this document may be a credential: pin the shape rather than
    // grep for words, because `auth: "key"` is a field, not a secret
    const allowed = new Set([
      'provider', 'label', 'state', 'baseUrl', 'auth', 'tos', 'capabilities', 'catalogueModels',
      'verifiedAt', 'probeModel', 'probe', 'configuredModels', 'combos',
    ]);
    for (const p of json.providers) {
      for (const key of Object.keys(p)) assert.ok(allowed.has(key), `unexpected field "${key}" in a provider document`);
    }

    // the counts add up, or the headline lies
    assert.equal(
      json.summary.verified + json.summary.awaitingProbe + json.summary.identities,
      json.summary.total,
      'every entry is in exactly one state',
    );
  } finally {
    await gw.close();
  }
});

test('an overlay written by a probe turns an identity into a route, on the page', async () => {
  await withHome(async (home) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'catalog-verified.json'),
      JSON.stringify({
        version: 1,
        entries: [{ provider: 'groq', base_url: 'https://api.groq.com/openai/v1', verified_at: 1763000000000, probe_model: 'openai/gpt-oss-120b', models: ['openai/gpt-oss-120b'] }],
      }),
    );

    const { gw, base } = await bootProviders();
    try {
      const json = await (await fetch(`${base}/api/providers`)).json();
      const groq = json.providers.find((p) => p.provider === 'groq');
      assert.ok(groq, 'groq is in the catalogue');
      assert.equal(groq.state, 'verified', 'an observation on this machine makes it a route');
      assert.equal(groq.verifiedAt, 1763000000000);
      assert.equal(groq.probeModel, 'openai/gpt-oss-120b');
      assert.equal(json.summary.verified, 1);
    } finally {
      await gw.close();
    }
  });
});

test('a corrupt overlay is ignored rather than taking the catalogue with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sui-overlay-'));
  const corrupt = join(dir, 'catalog-verified.json');
  const good = join(dir, 'good.json');
  writeFileSync(corrupt, '{not json');
  writeFileSync(good, JSON.stringify({ entries: [{ provider: 'x', verified_at: 1 }] }));

  const observed = readVerifiedOverlay([corrupt, good]);
  assert.equal(observed.length, 1, 'the readable overlay is used');
  assert.equal(observed[0].provider, 'x');
  assert.deepEqual(readVerifiedOverlay([corrupt]), [], 'and a lone corrupt file is an empty overlay, not a crash');
});

/* ------------------------------- the catalogue has to resolve from a package */

test('the catalogue is asked of the package first, not of the checkout', () => {
  // From an install, neither `process.cwd()/packages/catalog` nor the path three
  // levels above this file exists, so both fallbacks pointed at nothing and the
  // background prober found zero entries and never ran.
  const fromPackage = dirname(fileURLToPath(pathToFileURL(fileURLToPath(import.meta.resolve('@drsamonline/catalog/seed.json'))).href));
  assert.equal(catalogueDirs()[0], fromPackage, 'the package is the first place asked');
  assert.ok(loadCatalogue().length > 10, 'and it finds the entries there');
  assert.ok(loadProbeTargets().every((e) => e.base_url), 'a probe target must have an endpoint');
});

test('an explicit catalogue directory still wins, for tests and unusual layouts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sui-catalog-'));
  assert.deepEqual(catalogueDirs(dir), [dir]);
  assert.deepEqual(loadCatalogue(dir), [], 'an empty directory is empty, not a reason to fall back');
});

/* ----------------------------- probing from the page needs consent, twice */

test('probing from the dashboard is off unless the config says otherwise', async () => {
  const { gw, base } = await bootProviders();
  try {
    const json = await (await fetch(`${base}/api/providers`)).json();
    assert.equal(json.probeEnabled, false, 'the page must be able to tell it cannot probe');

    const res = await fetch(`${base}/api/providers/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'groq' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.type, 'probe_disabled');
    assert.match(body.error.message, /dashboard\.allowProbe/, 'the refusal names the setting');
  } finally {
    await gw.close();
  }
});

test('with the flag on but a public bind, the probe still needs the admin token', async () => {
  const config = testConfig({ config: { dashboard: { allowProbe: true }, server: { host: '0.0.0.0', port: 0 } } });
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'groq' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.type, 'admin_required');
  } finally {
    await gw.close();
  }
});

test('a probe from the page reports, and never promotes', async () => {
  // No provider egress here, so the answer is "no answer" — which is the honest
  // result and exercises the whole path: guard, catalogue lookup, probe, report.
  const config = testConfig({ config: { dashboard: { allowProbe: true } } });
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'groq', timeoutMs: 300 }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.provider, 'groq');
    assert.equal(json.promoted, false, 'a probe from a page must not promote a route');
    assert.match(json.note, /--write/);
    assert.equal(typeof json.result.ok, 'boolean');
    assert.ok(json.result.reasons.length || json.result.ok, 'a failure must say why');

    // and the catalogue is unchanged: no verification was written
    const after = await (await fetch(`http://127.0.0.1:${port}/api/providers`)).json();
    assert.equal(after.summary.verified, 0, 'nothing was promoted by probing');
  } finally {
    await gw.close();
  }
});

test('probing an unknown provider is a 404, not a silent nothing', async () => {
  const config = testConfig({ config: { dashboard: { allowProbe: true } } });
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'not-a-provider' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await gw.close();
  }
});
