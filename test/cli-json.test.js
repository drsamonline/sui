import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `--json` contract, checked as a contract rather than command by command.
 *
 * Before this, three commands kept it and the rest printed a table with a JSON
 * blob appended, or printed a table and nothing else — so "scriptable" was true of
 * whichever command you happened to try. The rule is one line: stdout parses as
 * exactly one JSON document, diagnostics go to stderr, and the exit code is the
 * one the human path would have used.
 *
 * The shapes are deliberately not identical — a `probe` document and a `vault`
 * document answer different questions — so this checks the transport, and the
 * fields are documented in docs/API.md.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'apps', 'cli', 'bin', 'sui.js');

/** A config with a mock provider: no network, no key, no quota. */
function mockConfig(dir) {
  const path = join(dir, 'sui.config.json');
  writeFileSync(
    path,
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      providers: { mock: { type: 'mock', mock: { delayMs: 1 } } },
      models: { 'mock-1': { provider: 'mock', model: 'mock-1', costPer1kIn: 0, costPer1kOut: 0, quality: 3 } },
      combos: { 'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['mock-1'] } },
      budgets: { dailyUsd: 5 },
      guardrails: { logPrompts: false },
      paidTiers: { enabled: false },
      apiKeys: [],
    }),
  );
  return path;
}

/** Run a command and return its stdout, stderr and exit code — never throw. */
function runJson(argv, env, cwd = ROOT) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...argv], { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return { stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? ''), code: err?.status ?? 1 };
  }
}

test('every --json command writes exactly one document to stdout, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sui-cli-json-'));
  const config = mockConfig(dir);
  const env = { SUI_HOME: join(dir, '.sui'), SUI_QUIET: '1' };

  // `command` is the field the newer documents carry so a caller can tell two
  // documents apart; the older ones (models, cost) predate it and are checked for
  // parseability only, which is what a script actually needs.
  const cases = [
    { argv: ['invariants', '--config', config, '--json'], command: 'invariants' },
    { argv: ['kits', '--json'], command: 'kits' },
    { argv: ['tokens', '--check', '--json'], command: 'tokens' },
    { argv: ['budget', '--json'], command: 'budget' },
    { argv: ['tools', '--json'], command: 'tools' },
    { argv: ['catalog', '--json'], command: null },
    { argv: ['free-budget', '--json'], command: null },
    { argv: ['recipe', 'list', '--json'], command: 'recipe' },
    { argv: ['vault', 'status', '--json'], command: 'vault' },
    { argv: ['local', '--json', '--timeout', '100'], command: 'local' },
    { argv: ['models', '--config', config, '--json'], command: null },
    { argv: ['cost', '--config', config, '--json'], command: null },
  ];

  for (const { argv, command } of cases) {
    const { stdout, code } = runJson(argv, env);
    const label = `sui ${argv.filter((a) => !a.startsWith('--') || a === '--json').join(' ')}`;
    assert.ok(code === 0 || code === 1, `${label} exited ${code}`);
    let doc;
    assert.doesNotThrow(() => {
      doc = JSON.parse(stdout);
    }, `${label}: stdout was not one JSON document:\n${stdout.slice(0, 200)}`);
    assert.equal(typeof doc, 'object', `${label}: the document must be an object`);
    if (command) assert.equal(doc.command, command, `${label}: the document must say which command produced it`);
  }
});

test('a --json document is not a table with JSON stapled on', () => {
  // The failure mode this rules out: `console.log(table(...))` followed by
  // `console.log(JSON.stringify(...))`, which parses only if you strip the table.
  const { stdout } = runJson(['kits', '--json'], {});
  assert.equal(/Vendored kits/.test(stdout), false, 'the human heading must not reach stdout in --json mode');
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test('the human path still prints what a person reads', () => {
  // An early return added for --json must not have removed the table.
  const { stdout } = runJson(['kits'], {});
  assert.match(stdout, /Vendored kits/);
  assert.match(stdout, /\d+\/\d+|\b7\b|loaded/, 'the table must still show the kits');

  const budget = runJson(['budget'], {}).stdout;
  assert.match(budget, /preset/, 'budget must still name a preset for a person');
});

test('--json does not change the exit code the human path would have used', () => {
  // `tokens --check` exits 1 when a pair fails AA; the document has to agree.
  const withJson = runJson(['tokens', '--check', '--json'], {});
  const doc = JSON.parse(withJson.stdout);
  assert.equal(doc.ok, doc.failures === 0, 'the document must agree with itself');
  assert.equal(withJson.code, doc.ok ? 0 : 1, 'the exit code must follow the document');
});

/* -------------------- the commands that narrate, and the one that cannot */

test('config get answers a script, and distinguishes missing from null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sui-cli-json-'));
  const config = mockConfig(dir);

  const present = runJson(['config', 'get', 'budgets.dailyUsd', '--config', config, '--json'], {});
  const doc = JSON.parse(present.stdout);
  assert.equal(doc.command, 'config');
  assert.equal(doc.found, true);
  assert.equal(doc.value, 5);

  const missing = runJson(['config', 'get', 'budgets.nope', '--config', config, '--json'], {});
  const gone = JSON.parse(missing.stdout);
  assert.equal(gone.found, false, 'a missing key must be a field, not a bare null');
  assert.equal(gone.value, null);
  assert.equal(missing.code, 1, 'and the exit code still says it was not found');
});

test('tools --set answers a script, and a dry run says it wrote nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sui-cli-json-'));
  const config = mockConfig(dir);
  const { stdout } = runJson(['tools', '--set', 'env', '--config', config, '--dry-run', '--json'], {});
  const doc = JSON.parse(stdout);
  assert.equal(doc.command, 'tools');
  assert.equal(doc.action, 'set');
  assert.equal(doc.tool, 'env');
  assert.equal(doc.dryRun, true);
  assert.equal(doc.written, false, 'a dry run must not claim a write');
});

test('init answers a script, with the round trip that proves it worked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sui-cli-json-'));
  const { stdout, code } = runJson(['init', '--demo', '--no-serve', '--json'], { SUI_HOME: join(dir, '.sui'), SUI_QUIET: '1' }, dir);
  assert.equal(code, 0);
  const doc = JSON.parse(stdout);
  assert.equal(doc.command, 'init');
  assert.equal(doc.ok, true);
  assert.ok(doc.configPath.endsWith('sui.config.json'));
  assert.equal(doc.demo, true);
  assert.ok(doc.roundTrip, 'onboarding without a round trip is not onboarding (I7)');
  assert.equal(typeof doc.roundTrip.modelId, 'string');
});

test('sui mcp refuses --json, and says why rather than printing nothing', () => {
  // On stdio, stdout is the protocol channel; a document there corrupts the
  // stream. Over http the command never finishes, so there is no result to
  // describe. Refusing is the honest answer.
  const { stderr, code } = runJson(['mcp', '--json'], {});
  assert.equal(code, 1);
  assert.match(stderr, /stdout is the protocol channel/);
  assert.match(stderr, /sui models --json/, 'the refusal names the command that can answer');
});
