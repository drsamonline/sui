import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '@sui/cli/src/onboarding.js';
import { run as cli } from '@sui/cli/src/cli.js';
import { normalizeConfig } from '@sui/core';

function tmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sui-init-'));
  return { dir, env: { SUI_HOME: join(dir, '.sui'), SUI_QUIET: '1' } };
}

const deadTemplate = {
  providers: { unreachable: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'TEST_KEY', timeoutMs: 400 } },
  models: { m1: { provider: 'unreachable', model: 'm1', costPer1kIn: 0, costPer1kOut: 0, quality: 3 } },
  combos: { 'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['m1'] } },
  server: { host: '127.0.0.1', port: 8787 },
};

test('first run with no keys completes end to end on the demo provider, and says it is a demo', async () => {
  const { dir, env } = tmpProject();
  const lines = [];
  const result = await runInit({ cwd: dir, env, out: (l = '') => lines.push(l) });

  assert.equal(result.ok, true);
  assert.equal(result.demo, true);
  assert.ok(existsSync(join(dir, 'sui.config.json')), 'config must be written');
  assert.equal(result.roundTrip.ok, true);
  assert.equal(result.roundTrip.verified, false, 'a demo answer is never "verified"');
  assert.match(result.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

  const text = lines.join('\n');
  assert.match(text, /demo provider/);
  assert.match(text, /not a real model/);
  assert.match(text, /Endpoint ready/);
  assert.match(text, /OPENAI_BASE_URL=/);

  const written = JSON.parse(readFileSync(join(dir, 'sui.config.json'), 'utf8'));
  assert.equal(written.providers.demo.type, 'mock');
  assert.doesNotThrow(() => normalizeConfig(written, { env }));
});

test('first run refuses to report success when the round-trip fails', async () => {
  const { dir, env } = tmpProject();
  const lines = [];
  const result = await runInit({
    cwd: dir,
    env: { ...env, TEST_KEY: 'present-but-pointless' },
    template: deadTemplate,
    out: (l = '') => lines.push(l),
  });

  assert.equal(result.ok, false, 'no green tick without a real answer');
  assert.equal(result.roundTrip.ok, false);
  const text = lines.join('\n');
  assert.match(text, /Nothing was marked ready/);
  assert.doesNotMatch(text, /Endpoint ready/);
});

test('a second run keeps the previous config as a backup', async () => {
  const { dir, env } = tmpProject();
  await runInit({ cwd: dir, env, out: () => {} });
  await runInit({ cwd: dir, env, out: () => {} });
  const { readdirSync } = await import('node:fs');
  const backups = readdirSync(dir).filter((f) => f.startsWith('sui.config.json.bak-'));
  assert.equal(backups.length, 1);
});

test('sui models prints the combos and which models are ready', async () => {
  const { dir, env } = tmpProject();
  await runInit({ cwd: dir, env, out: () => {} });

  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await cli(['models', '--config', join(dir, 'sui.config.json')]);
  } finally {
    console.log = original;
  }
  const out = logs.join('\n');
  assert.match(out, /Combos/);
  assert.match(out, /chat-default/);
  assert.match(out, /ready/);
});

test('sui doctor runs a real turn and exits clean when a route answers', async () => {
  const { dir, env } = tmpProject();
  await runInit({ cwd: dir, env, out: () => {} });

  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const previousExit = process.exitCode;
  try {
    await cli(['doctor', '--config', join(dir, 'sui.config.json')]);
  } finally {
    console.log = original;
  }
  const out = logs.join('\n');
  assert.match(out, /sui doctor/);
  assert.match(out, /chat-default\s+ok/);
  assert.equal(process.exitCode, previousExit);
});

test('sui cost reports spend and turns from the ledger', async () => {
  const { dir, env } = tmpProject();
  await runInit({ cwd: dir, env, out: () => {} });

  const logs = [];
  const original = console.log;
  const originalHome = process.env.SUI_HOME;
  process.env.SUI_HOME = env.SUI_HOME;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await cli(['cost', '--config', join(dir, 'sui.config.json')]);
  } finally {
    console.log = original;
    if (originalHome === undefined) delete process.env.SUI_HOME;
    else process.env.SUI_HOME = originalHome;
  }
  const out = logs.join('\n');
  assert.match(out, /Spend today/);
  assert.match(out, /Turns\s+1/);
});

test('an unknown command fails loudly without a stack trace', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const previousExit = process.exitCode;
  try {
    await cli(['frobnicate']);
  } finally {
    console.error = original;
    process.exitCode = previousExit;
  }
  assert.match(errors.join('\n'), /Unknown command "frobnicate"/);
  assert.match(errors.join('\n'), /sui help/);
});
