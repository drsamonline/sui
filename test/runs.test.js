import test from 'node:test';
import assert from 'node:assert/strict';
import { RunTracker, RunRegistry, callSignature } from '@sui/guardrails';
import { makeGateway, testConfig } from './helpers.js';

const T0 = 1_700_000_000_000;

/* ------------------------------------------------------------- the bounds */

test('a run with no limits allows everything', () => {
  const run = new RunTracker().start(T0);
  for (let i = 0; i < 100; i++) {
    assert.equal(run.check({ tool: 'chat', input: { i }, now: T0 }).decision, 'allow');
    run.record({ tool: 'chat', input: { i }, now: T0 });
  }
});

test('the step limit stops the run and says how many', () => {
  const run = new RunTracker({ maxSteps: 2 }).start(T0);
  run.record({ tool: 'chat', input: { n: 1 }, now: T0 });
  run.record({ tool: 'chat', input: { n: 2 }, now: T0 });
  const decision = run.check({ tool: 'chat', input: { n: 3 }, now: T0 });
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason, /step limit reached \(2\/2\)/);
});

test('the cost limit adds up what was recorded', () => {
  const run = new RunTracker({ maxUsd: 0.01 }).start(T0);
  run.record({ tool: 'chat', input: { n: 1 }, costUsd: 0.006, now: T0 });
  assert.equal(run.check({ tool: 'chat', input: { n: 2 }, now: T0 }).decision, 'allow');
  run.record({ tool: 'chat', input: { n: 2 }, costUsd: 0.006, now: T0 });
  const decision = run.check({ tool: 'chat', input: { n: 3 }, now: T0 });
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason, /run budget exhausted \(\$0\.0120 of \$0\.01\)/);
});

test('the time limit uses the clock it is given, not the wall clock', () => {
  const run = new RunTracker({ maxMs: 60_000 }).start(T0);
  assert.equal(run.check({ tool: 'chat', input: {}, now: T0 + 30_000 }).decision, 'allow');
  const late = run.check({ tool: 'chat', input: {}, now: T0 + 61_000 });
  assert.equal(late.decision, 'deny');
  assert.match(late.reason, /time limit reached \(61s of 60s\)/);
});

test('the same call with the same input is a loop, and different input is not', () => {
  const run = new RunTracker({ maxRepeats: 2, loopWindow: 30 }).start(T0);
  for (let i = 0; i < 2; i++) {
    assert.equal(run.check({ tool: 'search', input: { q: 'same' }, now: T0 }).decision, 'allow');
    run.record({ tool: 'search', input: { q: 'same' }, now: T0 });
  }
  const loop = run.check({ tool: 'search', input: { q: 'same' }, now: T0 });
  assert.equal(loop.decision, 'deny');
  assert.match(loop.reason, /loop detected/);
  assert.equal(run.check({ tool: 'search', input: { q: 'different' }, now: T0 }).decision, 'allow');
});

test('a loop outside the window is not a loop', () => {
  const run = new RunTracker({ maxRepeats: 2, loopWindow: 10 }).start(T0);
  for (let i = 0; i < 2; i++) run.record({ tool: 'search', input: { q: 'same' }, now: T0 });
  const later = run.check({ tool: 'search', input: { q: 'same' }, now: T0 + 60_000 });
  assert.equal(later.decision, 'allow', 'the earlier calls fell out of the window');
});

test('a gated tool needs approval for that exact call, once', () => {
  const run = new RunTracker({ requireApproval: ['shell'] }).start(T0);
  assert.equal(run.check({ tool: 'shell', input: { cmd: 'ls' }, now: T0 }).decision, 'needsApproval');

  run.approve({ tool: 'shell', input: { cmd: 'ls' } });
  assert.equal(run.check({ tool: 'shell', input: { cmd: 'ls' }, now: T0 }).decision, 'allow');

  // a different command is a different call
  assert.equal(run.check({ tool: 'shell', input: { cmd: 'rm -rf /' }, now: T0 }).decision, 'needsApproval');

  // and the approval is spent by the call it approved
  run.record({ tool: 'shell', input: { cmd: 'ls' }, now: T0 });
  assert.equal(run.check({ tool: 'shell', input: { cmd: 'ls' }, now: T0 }).decision, 'needsApproval');
});

test('the signature depends on the input, not on key order', () => {
  assert.equal(callSignature('t', { a: 1, b: 2 }), callSignature('t', { b: 2, a: 1 }));
  assert.notEqual(callSignature('t', { a: 1 }), callSignature('t', { a: 2 }));
});

test('the snapshot reports the limits, the spend and the last denials', () => {
  const run = new RunTracker({ maxSteps: 1, maxUsd: 5 }).start(T0);
  run.record({ tool: 'chat', input: {}, costUsd: 0.5, now: T0 });
  run.check({ tool: 'chat', input: { again: true }, now: T0 });
  const snap = run.snapshot();
  assert.equal(snap.steps, 1);
  assert.equal(snap.spentUsd, 0.5);
  assert.equal(snap.limits.maxSteps, 1);
  assert.equal(snap.denials.length, 1);
});

test('the registry starts, finds and finishes runs, and forgets old ones', () => {
  const registry = new RunRegistry({ maxRuns: 2, now: () => T0 });
  registry.start('a', { maxSteps: 1 });
  registry.start('b', {});
  assert.ok(registry.get('a'));

  registry.start('c', {});
  assert.equal(registry.runs.size, 2, 'the registry stays bounded');
  assert.equal(registry.get('a'), null, 'the oldest finished run was evicted');

  registry.finish('c');
  assert.equal(registry.get('c').snapshot().finished, true);
});

/* ------------------------------------------------------------ over HTTP */

async function boot() {
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  return { gw, base: `http://127.0.0.1:${port}` };
}

const chat = (base, runId, content = 'hello') =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(runId ? { 'x-sui-run': runId } : {}) },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content }] }),
  });

test('a request with no run header is unbounded, as before', async () => {
  const { gw, base } = await boot();
  for (let i = 0; i < 5; i++) assert.equal((await chat(base, null, `turn ${i}`)).status, 200);
  await gw.close();
});

test('a bounded run answers until its step limit, then 409 with the reason', async () => {
  const { gw, base } = await boot();
  const created = await (await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'r1', limits: { maxSteps: 2 } }),
  })).json();
  assert.equal(created.id, 'r1');

  assert.equal((await chat(base, 'r1', 'one')).status, 200);
  assert.equal((await chat(base, 'r1', 'two')).status, 200);

  const denied = await chat(base, 'r1', 'three');
  assert.equal(denied.status, 409);
  const body = await denied.json();
  assert.equal(body.error.type, 'run_bounded');
  assert.match(body.error.message, /step limit reached/);

  const state = await (await fetch(`${base}/api/runs/r1`)).json();
  assert.equal(state.run.steps, 2);
  await gw.close();
});

test('an unknown run id is a 404 rather than a silent unbounded call', async () => {
  const { gw, base } = await boot();
  const res = await chat(base, 'ghost', 'hello');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, 'unknown_run');
  await gw.close();
});

test('an approval is per call and does not cover the next one', async () => {
  const { gw, base } = await boot();
  await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'r2', limits: { requireApproval: ['chat'] } }),
  });

  const gated = await chat(base, 'r2', 'needs a human');
  assert.equal(gated.status, 409);
  assert.equal((await gated.json()).error.type, 'run_needs_approval');

  await fetch(`${base}/api/runs/r2/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'chat', input: { combo: 'chain', prompt: 'needs a human' } }),
  });

  assert.equal((await chat(base, 'r2', 'needs a human')).status, 200, 'the approved call proceeds');
  assert.equal((await chat(base, 'r2', 'needs a human')).status, 409, 'and the approval is spent');
  await gw.close();
});

test('the run list shows what each run has done', async () => {
  const { gw, base } = await boot();
  await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'r3', limits: { maxSteps: 5 } }),
  });
  await chat(base, 'r3', 'one');

  const list = await (await fetch(`${base}/api/runs`)).json();
  const run = list.runs.find((r) => r.id === 'r3');
  assert.equal(run.steps, 1);
  assert.equal(run.limits.maxSteps, 5);
  await gw.close();
});
