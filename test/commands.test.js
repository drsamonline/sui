import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as cli } from '@drsamonline/cli/src/cli.js';
import { runInit } from '@drsamonline/cli/src/onboarding.js';

async function withProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sui-cmd-'));
  const env = { SUI_HOME: join(dir, '.sui'), SUI_QUIET: '1' };
  await runInit({ cwd: dir, env, out: () => {} });
  return { dir, env, configPath: join(dir, 'sui.config.json') };
}

async function capture(fn) {
  const logs = [];
  const original = console.log;
  const previousExit = process.exitCode;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return { out: logs.join('\n'), exitCode: process.exitCode, previousExit };
}

test('config get and set read and write a dot path, with validation', async () => {
  const { configPath } = await withProject();
  const { out } = await capture(() => cli(['config', 'set', 'budgets.dailyUsd', '7', '--config', configPath]));
  assert.match(out, /budgets\.dailyUsd: \d+ → 7/);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).budgets.dailyUsd, 7);

  const got = await capture(() => cli(['config', 'get', 'budgets.dailyUsd', '--config', configPath]));
  assert.equal(got.out.trim(), '7');
});

test('config set refuses a change that would break the config, and writes nothing', async () => {
  const { configPath } = await withProject();
  const before = readFileSync(configPath, 'utf8');
  await assert.rejects(
    () => cli(['config', 'set', 'combos.chat-default.strategy', 'nonsense', '--config', configPath]),
    (err) => {
      assert.match(err.message, /would break the config/);
      assert.match(err.message, /fallback, weighted, cheapest, latency/);
      return true;
    },
  );
  assert.equal(readFileSync(configPath, 'utf8'), before, 'the file must be untouched');
});

test('config show redacts secrets', async () => {
  const { configPath } = await withProject();
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  raw.apiKeys = [{ key: 'sk-should-not-print' }];
  writeFileSync(configPath, JSON.stringify(raw, null, 2));

  const { out } = await capture(() => cli(['config', 'show', '--config', configPath]));
  assert.equal(out.includes('sk-should-not-print'), false);
  assert.match(out, /apiKeyCount/);
});

test('catalog lists the seed and the generated entries, all unverified', async () => {
  const { out } = await capture(() => cli(['catalog']));
  assert.match(out, /catalogue entries/);
  assert.match(out, /0 routable/);
  assert.match(out, /awaiting a probe/);
  assert.match(out, /pollinations/);
});

test('catalog search ranks with search-kit', async () => {
  const { out } = await capture(() => cli(['catalog', 'ollama']));
  assert.match(out, /provider/);
  assert.match(out, /ollama/, 'the query should surface the matching entry');
  assert.match(out, /needs a probe/);
});

test('the token audit passes WCAG AA in both modes', async () => {
  const previous = process.exitCode;
  const { out } = await capture(() => cli(['tokens', '--check']));
  process.exitCode = previous;
  assert.match(out, /All pairs pass/);
  assert.equal(/FAIL/.test(out), false);
  assert.match(out, /computed by tokens-kit/);
});

test('keys hash rewrites plaintext keys and keeps the file valid', async () => {
  const { configPath } = await withProject();
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  raw.apiKeys = [{ name: 'a', key: 'sk-plain-one' }];
  writeFileSync(configPath, JSON.stringify(raw, null, 2));

  const { out } = await capture(() => cli(['keys', 'hash', '--config', configPath]));
  assert.match(out, /Hashed 1 key/);
  const after = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(after.apiKeys[0].key, undefined);
  assert.match(after.apiKeys[0].key_hash, /^[a-f0-9]{64}$/);
});

test('cost --export --gzip writes a compressed file that gunzips back', async () => {
  const { dir, env, configPath } = await withProject();
  const originalHome = process.env.SUI_HOME;
  process.env.SUI_HOME = env.SUI_HOME;
  const target = join(dir, 'usage.csv');
  try {
    await capture(() => cli(['cost', '--config', configPath, '--export', target, '--gzip']));
  } finally {
    if (originalHome === undefined) delete process.env.SUI_HOME;
    else process.env.SUI_HOME = originalHome;
  }
  assert.ok(existsSync(`${target}.gz`), 'the gzip file should exist');
  const { gunzipSync } = await import('node:zlib');
  const text = gunzipSync(readFileSync(`${target}.gz`)).toString('utf8');
  assert.match(text, /^timestamp_iso,provider,model/);
});

/* ---------------------------------- flags that take a value must parse as one */

test('every flag the help text shows with a value is in VALUE_FLAGS', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'apps', 'cli', 'src', 'cli.js'), 'utf8');

  const declared = /const VALUE_FLAGS = new Set\(\[([^\]]+)\]\)/.exec(source)?.[1] ?? '';
  const valueFlags = new Set(declared.split(',').map((f) => f.trim().replace(/^'|'$/g, '')).filter(Boolean));

  // Take only the lines that *are* help output. Slicing to the next `];` swept in
  // prose from the code below it, which then looked like documented flags. The
  // command prefix is interpolated now, so match either form.
  const helpText = (source.match(/^\s*(?:npx sui|\$\{RUN_AS\}) .*$/gm) ?? []).join('\n');
  assert.ok(helpText.length > 200, 'the help text could not be found');
  const documented = new Set();
  // same line only: `--no-workers` at the end of a line is boolean, and the flag
  // on the next line belongs to a different example
  for (const match of helpText.matchAll(/--([a-z-]+)[ \t]+(<[a-z]+>|[A-Za-z0-9][A-Za-z0-9|<>._-]*)/g)) {
    const flag = match[1];
    const value = match[2];
    // `--demo  --force` style: a flag followed by another flag is boolean
    if (value.startsWith('--')) continue;
    // a real value is a placeholder or a lowercase token; `--check WCAG AA on…`
    // is a boolean flag followed by prose, and WCAG is not a value
    if (!value.startsWith('<') && !/^[a-z0-9][a-z0-9|._-]*$/.test(value)) continue;
    documented.add(flag);
  }

  assert.ok(documented.size >= 3, `expected several value-taking flags in the help text, found ${documented.size}`);
  const missing = [...documented].filter((flag) => !valueFlags.has(flag));
  assert.deepEqual(
    missing,
    [],
    `these flags are documented with a value but parse as booleans: ${missing.join(', ')} — add them to VALUE_FLAGS`,
  );
});

test('a documented value flag actually receives its value', async () => {
  const { execFileSync } = await import('node:child_process');
  // `--role` parsed as `true` three separate times before this existed, and each
  // time the failure was a confusing runtime error rather than a parse error
  // the command should reject the role by name, which proves it received the
  // value rather than parsing it as `true`
  let out = '';
  try {
    out = execFileSync(process.execPath, ['apps/cli/bin/sui.js', 'start', '--role', 'nonsense', '--port', '0'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SUI_HOME: '/tmp/sui-flag-test' },
      stdio: 'pipe',
    }).toString();
  } catch (err) {
    out = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
  }
  assert.match(out, /Unknown plane role "nonsense"/);
});

test('--version and --help answer before anything else', async () => {
  const { execFileSync } = await import('node:child_process');
  const run = (arg) =>
    execFileSync(process.execPath, ['apps/cli/bin/sui.js', arg], { cwd: process.cwd(), encoding: 'utf8' });

  // both arrive as flags rather than as a command, and both used to fall through
  // to the first-run onboarding
  assert.match(run('--version'), /^\d+\.\d+\.\d+/);
  assert.match(run('-v'), /^\d+\.\d+\.\d+/);
  assert.match(run('--help'), /sui \d+\.\d+\.\d+ — /);
});

test('the CLI never tells you to run a command that cannot work', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // a first run in an empty home, invoked through the wrapper
  const home = mkdtempSync(join(tmpdir(), 'sui-hint-'));
  const out = execFileSync(process.execPath, ['apps/cli/bin/sui.js', '--demo'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SUI_HOME: home },
    timeout: 60_000,
  });

  // npx sui cannot work until the package is published; the hint must not say it
  assert.equal(/npx sui/.test(out), false, 'the first-run hint told the user to run npx sui, which fails before a publish');
  assert.match(out, /Start it with: (\.\/sui|\.\\sui\.cmd|sui) start/);
});

test('--json means stdout is the document, on every command that has it', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'sui-json-'));
  const commands = [
    ['tenants', '--json'],
    ['catalog', '--json'],
    ['cost', '--json'],
    ['savings', '--json'],
  ];

  for (const args of commands) {
    const out = execFileSync(process.execPath, ['apps/cli/bin/sui.js', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SUI_HOME: home },
      timeout: 90_000,
    });
    // a preamble on stdout makes the output unparseable, which is how a CI step
    // finds out before a user does
    assert.doesNotThrow(() => JSON.parse(out), `sui ${args.join(' ')} did not emit pure JSON: ${out.slice(0, 80)}`);
  }
});

test('probe --json emits pure JSON too, even when nothing answers', async () => {
  const { execFileSync } = await import('node:child_process');
  // one provider, not all 29: with no DNS each lookup costs seconds, and this
  // test is about the shape of the output rather than the state of the network
  const out = execFileSync(process.execPath, ['apps/cli/bin/sui.js', 'probe', 'ollama', '--json', '--timeout', '200'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 90_000,
  });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.results));
  // every failure must say why, or the JSON is useless to a script
  for (const r of parsed.results.filter((x) => !x.ok)) {
    assert.ok(r.reasons.length > 0, `${r.provider} failed without a reason`);
  }
});

test('doctor diagnoses a missing config instead of refusing to look', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // `doctor` is the health check, and the most natural first command. Refusing with
  // "no config found" and nothing else turned it into a dead end.
  const home = mkdtempSync(join(tmpdir(), 'sui-doctor-'));
  const out = execFileSync(process.execPath, [join(process.cwd(), 'apps/cli/bin/sui.js'), 'doctor'], {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, SUI_HOME: home, SUI_CONFIG: '' },
    timeout: 90_000,
  });

  assert.match(out, /what this machine has/, 'it reports what it can see');
  assert.match(out, /node\s+v\d+/, 'the node version');
  assert.match(out, /catalogue\s+\d+ entries/, 'the catalogue count');
  assert.match(out, /would live at/, 'it names where a config would go, not "null"');
  assert.match(out, /init/, 'and the command that fixes it');
  assert.equal(/No sui config found/.test(out), false, 'a diagnosis, not a refusal');
});
