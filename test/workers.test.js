import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createGateway, makeGateway, testConfig } from './helpers.js';
import { startWorkers, loadProbeTargets } from '@sui/gateway/src/workers.js';
import { ResponseCache } from '@sui/telemetry';

/** A catalogue directory holding one entry that points at a local fake. */
function catalogDirWith(baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'sui-workers-'));
  writeFileSync(
    join(dir, 'seed.json'),
    JSON.stringify({
      entries: [
        { provider: 'local-fake', base_url: baseUrl, auth: 'none', model_family: 'fake', capabilities: ['chat'], needs_probe: true },
        { provider: 'unresolved', auth: 'none', capabilities: ['chat'] },
      ],
    }),
  );
  return dir;
}

async function fakeUpstream() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('only entries with a resolved base_url are probe targets', () => {
  const dir = catalogDirWith('http://127.0.0.1:9/v1');
  const targets = loadProbeTargets(dir);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].provider, 'local-fake');
});

test('workers are opt-in: a gateway created programmatically starts none', async () => {
  const gw = await makeGateway(testConfig());
  const snapshot = gw.workers.snapshot();
  assert.equal(snapshot.enabled, false);
  assert.deepEqual(snapshot.jobs, []);
  await gw.close();
});

test('startWorkers registers the prober and the cache sweep', async () => {
  const fake = await fakeUpstream();
  const dir = catalogDirWith(fake.url);
  const config = { ...testConfig(), workers: { enabled: true, kickoffMs: 10, cacheSweepMs: 20, prober: { enabled: true, intervalMs: 60000, timeoutMs: 2000 } } };
  const cache = new ResponseCache({ ttlMs: 10 });

  const workers = startWorkers({ config, cache, ledger: { record() {} }, catalogDir: dir, now: Date.now });
  try {
    const names = workers.snapshot().jobs.map((j) => j.name);
    assert.deepEqual(names, ['prober', 'budget_alerts', 'cache_sweep']);

    // wait for the kickoff run to finish, not for a fixed guess
    const deadline = Date.now() + 3000;
    while (workers.snapshot().jobs.find((j) => j.name === 'prober').runs < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const after = workers.snapshot();
    const prober = after.jobs.find((j) => j.name === 'prober');
    assert.ok(prober.runs >= 1, 'the prober should have run on its kickoff');
    assert.equal(prober.lastError, null);
    assert.ok(Array.isArray(after.probes));
    assert.equal(after.probes[0].status, 'healthy');
  } finally {
    workers.stop();
    await fake.close();
  }
});

test('the prober job can be switched off without switching off the sweep', async () => {
  const config = { ...testConfig(), workers: { enabled: true, kickoffMs: 10, prober: { enabled: false } } };
  const workers = startWorkers({ config, cache: new ResponseCache({}), ledger: { record() {} }, catalogDir: catalogDirWith('http://127.0.0.1:9/v1') });
  assert.deepEqual(workers.snapshot().jobs.map((j) => j.name), ['budget_alerts', 'cache_sweep']);
  workers.stop();
});

test('stop() clears every timer, so the process can exit', async () => {
  const config = { ...testConfig(), workers: { enabled: true, kickoffMs: 10, cacheSweepMs: 10 } };
  const workers = startWorkers({ config, cache: new ResponseCache({}), ledger: { record() {} }, catalogDir: catalogDirWith('http://127.0.0.1:9/v1') });
  workers.stop();
  assert.equal(workers.jobs.every((j) => j.timer === null), true);
});

test('cache sweep drops expired entries and reports what it did', async () => {
  let clock = 1000;
  const cache = new ResponseCache({ ttlMs: 10, now: () => clock });
  cache.set('a', { text: 'x' });
  cache.set('b', { text: 'y' });
  clock += 1000;
  const result = cache.sweep();
  assert.equal(result.removed, 2);
  assert.equal(result.remaining, 0);
});

test('/api/workers reports the jobs and the probe state', async () => {
  const gw = await createGateway({ configObject: testConfig(), ledgerFile: null, env: { ...process.env } });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const json = await (await fetch(`http://127.0.0.1:${port}/api/workers`)).json();
  assert.equal(json.enabled, false, 'programmatic gateways run no workers');
  assert.deepEqual(json.jobs, []);

  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.ok(Array.isArray(status.probes));
  await gw.close();
});
