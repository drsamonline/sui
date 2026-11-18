import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore, SAMPLE_FIELDS } from '@sui/telemetry';
import { makeGateway, testConfig } from './helpers.js';
import http from 'node:http';
/**
 * GET a loopback URL with node:http rather than fetch.
 *
 * `fetch` keeps connections in a pool, and in CI that pool outlived the server:
 * `server.close()` then waited for a socket nobody was going to close, and the
 * test file timed out at sixty seconds while the same tests finished in two
 * locally. `agent: false` and `connection: close` remove the question.
 */
function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`GET ${path} timed out`)));
  });
}


const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sui-hist-')), 'history.jsonl');
const T0 = 1_800_000_000_000;

/* ---------------------------------------------------------- the store */

test('a sample carries exactly the fields it is allowed to', () => {
  const store = new HistoryStore({ now: () => T0 });
  const row = store.record({ modelId: 'm', ok: true, latencyMs: 120.6, state: 'closed' });
  assert.deepEqual(Object.keys(row).sort(), [...SAMPLE_FIELDS].sort());
  assert.equal(row.latencyMs, 121, 'rounded to a millisecond');
});

test('there is nowhere for a prompt to go', () => {
  const store = new HistoryStore({ now: () => T0 });
  const row = store.record({ modelId: 'm', ok: true, latencyMs: 10, prompt: 'my secret', text: 'also secret' });
  assert.equal(JSON.stringify(row).includes('secret'), false, 'unknown fields are dropped, not stored');
});

test('the series buckets by time and reports uptime', () => {
  const store = new HistoryStore({ now: () => T0, maxAgeMs: 30 * 24 * 3600_000 });
  // 24 hours of samples, one every 30 minutes, every 6th a failure
  for (let i = 0; i < 48; i++) {
    store.record({ ts: T0 - (47 - i) * 1800_000, modelId: 'm', ok: i % 6 !== 0, latencyMs: 100 + (i % 4) * 25 });
  }
  const series = store.series('m', { hours: 24, buckets: 12 });
  assert.equal(series.points.length, 12);
  assert.equal(series.samples, 48);
  assert.ok(series.uptime > 0 && series.uptime < 1, `uptime ${series.uptime} should be between 0 and 1`);
  const withSamples = series.points.filter((p) => p.samples > 0);
  assert.ok(withSamples.every((p) => typeof p.p50 === 'number'));
  assert.ok(withSamples.some((p) => p.errorRate > 0), 'the failures show up as an error rate');
});

test('a bucket with no samples says so instead of inventing zeros', () => {
  const store = new HistoryStore({ now: () => T0 });
  store.record({ ts: T0 - 60_000, modelId: 'm', ok: true, latencyMs: 100 });
  const series = store.series('m', { hours: 24, buckets: 4 });
  const empty = series.points.filter((p) => p.samples === 0);
  assert.ok(empty.length >= 2);
  assert.equal(empty[0].p50, null);
  assert.equal(empty[0].errorRate, null);
});

test('pruning respects both the row cap and the age cap', () => {
  const store = new HistoryStore({ now: () => T0, maxRows: 10, maxAgeMs: 3600_000 });
  for (let i = 0; i < 20; i++) store.record({ ts: T0 - 30_000, modelId: 'm', ok: true, latencyMs: 10 });
  store.prune();
  assert.ok(store.rows.length <= 10, `expected at most 10 rows, got ${store.rows.length}`);

  store.record({ ts: T0 - 10 * 3600_000, modelId: 'old', ok: true, latencyMs: 10 });
  store.prune();
  assert.equal(store.rows.some((r) => r.modelId === 'old'), false, 'a sample older than the age cap is dropped');
});

/* ------------------------------------------------------- persistence */

test('history survives a restart', () => {
  const file = tmpFile();
  const first = new HistoryStore({ file, now: () => T0 });
  first.record({ ts: T0 - 1000, modelId: 'm', ok: true, latencyMs: 90 });

  const second = new HistoryStore({ file, now: () => T0 });
  assert.equal(second.rows.length, 1, 'the file was read back');
  assert.equal(second.series('m', { hours: 24, buckets: 1 }).samples, 1);
});

test('a torn last line from a kill does not lose the rest of the file', () => {
  const file = tmpFile();
  const store = new HistoryStore({ file, now: () => T0 });
  store.record({ ts: T0 - 1000, modelId: 'm', ok: true, latencyMs: 90 });
  // simulate a process killed mid-write
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"ts":123,"modelId":"m","ok"`);

  const reopened = new HistoryStore({ file, now: () => T0 });
  assert.equal(reopened.rows.length, 1, 'the complete row is kept, the torn one is ignored');
});

test('a row with an unexpected field is dropped on load, not trusted', () => {
  const file = tmpFile();
  writeFileSync(file, `${JSON.stringify({ ts: T0 - 1000, modelId: 'm', ok: true, latencyMs: 5 })}\n${JSON.stringify({ ts: T0 - 500, modelId: 'm', ok: true, latencyMs: 5, prompt: 'leak' })}\n`);
  const store = new HistoryStore({ file, now: () => T0 });
  assert.equal(store.rows.length, 1);
});

test('an unwritable history file does not take the gateway down', () => {
  const store = new HistoryStore({ file: '/proc/nonexistent/history.jsonl', now: () => T0 });
  assert.doesNotThrow(() => store.record({ modelId: 'm', ok: true, latencyMs: 5 }));
  assert.equal(store.rows.length, 1, 'the sample is still in memory');
});

/* ------------------------------------------------------------ the API */

test('/api/history serves the series, and says so when it is off', async () => {
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const off = await getJson(port, '/api/history');
  assert.equal(off.enabled, false, 'workers are off, so there is no history — and it says that');

  await gw.close();
}, { timeout: 25_000 });

test('with workers on, /api/history reports what is on disk', async (t) => {
  // Steps are logged with their timing: when this hangs in CI, the log says which
  // line stopped rather than only that the file took sixty seconds.
  const step = (label, t0) => t.diagnostic(`${label}: ${Date.now() - t0}ms`);
  const dir = mkdtempSync(join(tmpdir(), 'sui-hist-api-'));
  // Workers on, prober off: the prober's kickoff does real network probes, and a
  // unit test that reaches the internet is slow on a runner with egress and
  // instant here — which is how this hung CI for fifteen minutes and never
  // showed up locally.
  let t0 = Date.now();
  const config = testConfig();
  config.workers = { enabled: true, kickoffMs: 0, prober: { enabled: false }, cacheSweepMs: 0, driftIntervalMs: 0, alertIntervalMs: 0 };
  const gw = await makeGateway(config, { startWorkers: true, historyFile: join(dir, 'history.jsonl') });
  step('gateway built', t0);

  gw.workers.history.record({ modelId: 'mock-a', ok: true, latencyMs: 40 });
  step('sample recorded', t0);

  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  step('listening', t0);
  const { port } = gw.server.address();
  const json = await getJson(port, '/api/history?model=mock-a&hours=24&buckets=6');
  step('history fetched', t0);

  assert.equal(json.enabled, true);
  assert.equal(json.series.length, 1);
  assert.equal(json.series[0].modelId, 'mock-a');
  assert.equal(json.series[0].points.length, 6);
  assert.ok(existsSync(join(dir, 'history.jsonl')), 'the sample was written to disk');

  t0 = Date.now();
  await gw.close();
  step('closed', t0);
}, { timeout: 25_000 });
