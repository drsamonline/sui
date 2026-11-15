import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftMonitor, driftFromLedger } from '@sui/telemetry';

const mk = (opts = {}) => new DriftMonitor({ baselineSamples: 10, threshold: 5, ...opts });

test('a steady series never alarms', () => {
  const m = mk();
  for (let i = 0; i < 100; i++) m.record('a', 100 + (i % 3));
  assert.equal(m.snapshot('a').alarm, null);
  assert.equal(m.alarms().length, 0);
});

test('a step change alarms, and says which direction and how far', () => {
  const m = mk();
  for (let i = 0; i < 20; i++) m.record('a', 100 + (i % 3));
  const after = m.record('a', 300);
  assert.equal(after.alarm.direction, 'up');
  assert.ok(after.alarm.cusum > 5);
  assert.equal(m.alarms().length, 1);
});

test('a slow slide alarms even though no single sample looks wrong', () => {
  const m = mk();
  for (let i = 0; i < 20; i++) m.record('a', 100 + (i % 2));
  let alarmedAt = null;
  for (let i = 1; i <= 40 && !alarmedAt; i++) {
    m.record('a', 100 + i);
    if (m.snapshot('a').alarm) alarmedAt = i;
  }
  assert.ok(alarmedAt !== null, 'a 1%-per-sample drift must be caught');
  assert.ok(alarmedAt < 20, `caught after ${alarmedAt} samples, which is the point of CUSUM`);
});

test('recovery clears the alarm once the level is back, not before', () => {
  const m = mk();
  for (let i = 0; i < 20; i++) m.record('a', 100 + (i % 3));
  m.record('a', 300);
  assert.ok(m.snapshot('a').alarm);

  // one good sample is not a recovery
  m.record('a', 100);
  assert.ok(m.snapshot('a').alarm, 'the smoothed level is still far away');

  for (let i = 0; i < 30; i++) m.record('a', 100 + (i % 3));
  assert.equal(m.snapshot('a').alarm, null, 'back within two standard deviations clears it');
});

test('a falling series is caught by the other arm', () => {
  const m = mk();
  for (let i = 0; i < 20; i++) m.record('a', 500 + (i % 3));
  for (let i = 0; i < 10; i++) m.record('a', 100);
  assert.equal(m.snapshot('a').alarm.direction, 'down');
});

test('noise alone is not drift: the false-alarm rate stays low', () => {
  const m = mk();
  let falseAlarms = 0;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 400; i++) {
    if (m.record('noise', 100 + (rand() * 6 - 3)).alarm) falseAlarms += 1;
  }
  assert.ok(falseAlarms <= 20, `expected few alarms on ±3 noise, saw ${falseAlarms}`);
});

test('a bad value is ignored rather than poisoning the baseline', () => {
  const m = mk();
  for (let i = 0; i < 12; i++) m.record('a', 100);
  const before = m.snapshot('a').baseline;
  m.record('a', Number.NaN);
  m.record('a', Infinity);
  assert.equal(m.snapshot('a').baseline, before);
});

test('driftFromLedger reads the ledger and reports per model, per signal', () => {
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push({ modelId: 'fast', ok: true, latencyMs: 100 + (i % 3), ts: i });
    records.push({ modelId: 'slow', ok: true, latencyMs: i < 20 ? 100 + (i % 3) : 400, ts: i });
  }
  const { alarms } = driftFromLedger({ records, minSamples: 10 });
  const latency = alarms.find((a) => a.key === 'slow:latency');
  assert.ok(latency, 'the model whose latency stepped up must be flagged');
  assert.equal(alarms.some((a) => a.key === 'fast:latency'), false, 'the steady model is not flagged');
});

test('driftFromLedger counts failures as a series of their own', () => {
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push({ modelId: 'flaky', ok: i < 20, latencyMs: 100, ts: i });
  }
  const { alarms } = driftFromLedger({ records, minSamples: 10 });
  assert.ok(alarms.some((a) => a.key === 'flaky:failures'), 'a target that started failing is drift too');
});

test('reset forgets a series, so a bad baseline can be cleared', () => {
  const m = mk();
  for (let i = 0; i < 12; i++) m.record('a', 100);
  m.record('a', 900);
  assert.ok(m.snapshot('a').alarm);
  m.reset('a');
  assert.equal(m.snapshot('a'), null);
});
