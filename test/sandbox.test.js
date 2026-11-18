import test from 'node:test';
import assert from 'node:assert/strict';
import { runCode, sandboxCapabilities, runAttackSuite, ATTACKS, DEFAULT_LIMITS } from '@drsamonline/sandbox';

const caps = await sandboxCapabilities();

test('the capabilities are reported, never assumed', () => {
  assert.equal(typeof caps.permissionModel, 'boolean');
  assert.equal(typeof caps.networkIsolated, 'boolean');
  assert.equal(caps.fullyIsolated, caps.permissionModel && caps.networkIsolated);
});

test('a benign snippet runs and its output comes back', async () => {
  const result = await runCode({ code: 'console.log("sum", [1,2,3].reduce((a,b)=>a+b,0))', capabilities: caps });
  assert.equal(result.ok, true);
  assert.match(result.stdout, /sum 6/);
  assert.ok(result.ms < 5000);
});

test('the default limits are small on purpose', () => {
  assert.ok(DEFAULT_LIMITS.wallMs <= 10_000);
  assert.ok(DEFAULT_LIMITS.heapMb <= 256);
  assert.ok(DEFAULT_LIMITS.maxOutputBytes <= 128 * 1024);
});

test('the attack suite contains every case it knows about', async () => {
  const suite = await runAttackSuite({ runCode, capabilities: caps });
  const failed = suite.results.filter((r) => !r.contained).map((r) => `${r.name}: ${r.stderr || r.stdout}`);
  assert.deepEqual(failed, [], `these escaped: ${failed.join(' | ')}`);
  assert.equal(suite.total, ATTACKS.length);
  assert.ok(suite.total >= 12, 'a suite this small proves very little');
});

test('every attack states what containment looks like', () => {
  for (const attack of ATTACKS) {
    assert.ok(['blocked', 'timeout', 'truncated', 'no-leak'].includes(attack.expect), `${attack.name} has no expectation`);
    assert.ok(attack.why.length > 10, `${attack.name} does not say why it matters`);
    assert.ok(attack.code.length > 0);
  }
});

test('a wall-clock kill stops a snippet the vm timeout cannot', async () => {
  const result = await runCode({
    code: 'const t = Date.now(); while (Date.now() - t < 60000) {}',
    capabilities: caps,
    limits: { wallMs: 600, vmTimeoutMs: 300 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.ms < 3000, `took ${result.ms}ms`);
});

test('output is capped, and the cap is reported', async () => {
  const result = await runCode({
    code: 'for (let i = 0; i < 50000; i++) console.log("spam spam spam spam")',
    capabilities: caps,
    limits: { maxOutputBytes: 2048 },
  });
  assert.ok(result.truncated || result.stdout.length <= 2048);
});

test('the environment is stripped, so a snippet cannot read a key', async () => {
  process.env.SUI_SANDBOX_CANARY = 'super-secret-value';
  const result = await runCode({ code: 'console.log(typeof process, typeof globalThis.process)', capabilities: caps });
  assert.equal(result.stdout.includes('super-secret-value'), false, 'the canary must not be readable');
  assert.match(result.stdout, /undefined/, '`process` does not exist in the context at all');
  delete process.env.SUI_SANDBOX_CANARY;
});

test('requireNoNetwork refuses to run when the boundary cannot be proven', async () => {
  const noIsolation = { ...caps, networkIsolated: false, fullyIsolated: false };
  const result = await runCode({ code: 'console.log(1)', capabilities: noIsolation, requireNoNetwork: true });
  assert.equal(result.refused, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not run/);
});

test('without the network jail, a run still happens but says what it lacks', async () => {
  const noIsolation = { ...caps, networkIsolated: false };
  const result = await runCode({ code: 'console.log("still runs")', capabilities: noIsolation });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.networkIsolated, false);
});
