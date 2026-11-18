import test from 'node:test';
import assert from 'node:assert/strict';


/* ------------------------------------------------- ADRs and contributing */

test('every ADR states its status, its context and its decision', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'docs', 'adr');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

  assert.ok(files.length >= 12, `expected at least 12 ADRs, found ${files.length}`);
  for (const file of files) {
    const body = readFileSync(join(dir, file), 'utf8');
    assert.match(body, /^# ADR-\d{4} — .+/, `${file} needs a titled heading`);
    assert.match(body, /\*\*Status:\*\*\s*(accepted|superseded|proposed|deprecated)/i, `${file} needs a status line`);
    assert.match(body, /## Context/, `${file} needs a Context section`);
    assert.match(body, /## Decision/, `${file} needs a Decision section`);
    assert.match(body, /## Consequences/, `${file} needs a Consequences section`);
  }
});

test('the ADR numbering has no gaps', async () => {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const numbers = readdirSync(join(process.cwd(), 'docs', 'adr'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => Number(f.slice(0, 4)))
    .sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1), 'ADRs are numbered 1..n with no gaps');
});

test('CONTRIBUTING states the invariant rule and names the four harnesses', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const body = readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
  for (const harness of ['npm test', 'npm run audit', 'npm run eval:self', 'npm run soak']) {
    assert.ok(body.includes(harness), `CONTRIBUTING must name ${harness}`);
  }
  assert.match(body, /enforcedBy/);
  assert.match(body, /provenBy/);
  assert.match(body, /Do not add a runtime dependency/);
});

test('the changelog names the current version and what it costs to adopt', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const changelog = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8');

  assert.ok(changelog.includes(`## ${pkg.version} —`), `CHANGELOG.md has no entry for ${pkg.version}`);
  assert.match(changelog, /### Known gaps/, 'every release states what it does not do');
  assert.match(changelog, /### Verified at this version/);
});

test('every package carries the same version as the root', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
  const dirs = ['packages', 'apps'].flatMap((dir) =>
    readdirSync(join(process.cwd(), dir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(process.cwd(), dir, d.name, 'package.json')),
  );
  for (const path of dirs) {
    const version = JSON.parse(readFileSync(path, 'utf8')).version;
    assert.equal(version, root, `${path} is at ${version}, the root is at ${root}`);
  }
});

test('the landing page claims the same invariant count as the code', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { INVARIANTS } = await import('@sui/core');
  const html = readFileSync(join(process.cwd(), 'docs', 'index.html'), 'utf8');
  assert.ok(html.includes(`${INVARIANTS.length} enforced`), `the landing page does not say ${INVARIANTS.length} enforced`);
  assert.ok(html.includes(`<div class="v num">${INVARIANTS.length}</div>`), 'the headline count is stale');
});

/* -------------------------------- the wrappers that replace npx */

test('a wrapper exists for each shell, and points at the CLI', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = process.cwd();

  for (const file of ['sui', 'sui.cmd', 'sui.ps1']) {
    assert.ok(existsSync(join(root, file)), `${file} is missing — Windows users cannot run the CLI without it`);
    const body = readFileSync(join(root, file), 'utf8');
    assert.match(body, /apps[\\/]cli[\\/]bin[\\/]sui\.js/, `${file} does not point at the CLI entry point`);
  }

  // the PowerShell one must not carry a broken policy hint: it did once
  const ps1 = readFileSync(join(root, 'sui.ps1'), 'utf8');
  assert.equal(/RemoteExecutionPolicy/.test(ps1), false, 'that is not a real execution policy');
  assert.match(ps1, /RemoteSigned/);
});

test('the Windows guide answers the question the user actually asked', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const guide = readFileSync(join(root(await import('node:path')), 'docs', 'WINDOWS.md'), 'utf8');
  // "npx doesnt work" is the whole reason the document exists
  assert.match(guide, /`npx sui` will not work/);
  assert.match(guide, /\.\\sui\.cmd doctor/);
  assert.match(guide, /npm link/);
  assert.match(guide, /install-windows\.ps1/);
});

function root(_path) {
  return process.cwd();
}

/* --------------------------- the README and landing page must not go stale */

test('the README states the real invariant count and test count', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { INVARIANTS } = await import('@sui/core');
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

  const words = { 15: 'Fifteen', 16: 'Sixteen', 17: 'Seventeen', 18: 'Eighteen', 19: 'Nineteen', 20: 'Twenty' };
  assert.ok(readme.includes(`${words[INVARIANTS.length]} invariants`), `README does not say "${words[INVARIANTS.length]} invariants"`);
  assert.equal(/Fifteen invariants/.test(readme), INVARIANTS.length === 15, 'a stale invariant count is a claim about the wrong code');
});

test('the README does not list shipped features as "not built yet"', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

  // this paragraph was true in phase 3 and became a lie; the features below all
  // shipped, so it must not name them as missing
  const shipped = ['canary prober', 'catalogue sync', 'compression engines', 'MCP/A2A', 'red-team self-test', 'tenant console', 'Weather Map', 'Savings Ledger', 'explain-my-route'];
  const staleLine = readme.split('\n').find((line) => /Not built yet/.test(line));
  if (staleLine) {
    for (const feature of shipped) {
      assert.equal(staleLine.includes(feature), false, `README still lists "${feature}" as not built`);
    }
  }
});

test('the landing page and the README agree on the catalogue size', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const seed = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'catalog', 'seed.json'), 'utf8'));
  const html = readFileSync(join(process.cwd(), 'docs', 'index.html'), 'utf8');

  assert.ok(html.includes(`<div class="v num">${seed.entries.length}</div>`), `the landing page does not say ${seed.entries.length} catalogue entries`);
});

/* -------------------- the landing page may not claim shipped work is missing */

test('the landing page does not list shipped features as not built', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const html = readFileSync(join(process.cwd(), 'docs', 'index.html'), 'utf8');

  // every one of these shipped; each was on the "not built yet" list at some point
  const shipped = [
    'No tenant console',
    'per-user cost attribution',
    'No catalogue entry has a resolved endpoint',
    '6 engines',
  ];
  for (const claim of shipped) {
    assert.equal(html.includes(claim), false, `the landing page still says "${claim}"`);
  }
});

test('the landing page limits list names what is actually left', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const html = readFileSync(join(process.cwd(), 'docs', 'index.html'), 'utf8');

  assert.match(html, /sui probe --write<\/code> on a networked machine/);
  assert.match(html, /The 72-hour soak has not been run/);
  assert.match(html, /Nothing is published to npm/);
  // the first-chunk refusal is a decision, so it must be stated as one
  assert.match(html, /No first-chunk clone, by choice/);
});

test('the landing page does not carry the stock AI-cadence patterns', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const html = readFileSync(join(process.cwd(), 'docs', 'index.html'), 'utf8');

  // named patterns from the writing guide, each of which was in the draft
  assert.equal(/Zero blind spots/.test(html), false, 'a claim with no evidence behind it');
  assert.equal(/not a green tick/.test(html), false, 'not-X-but-Y contrast');
  assert.equal(/Nothing here is marked finished because it was written/.test(html), false, 'interpretive metadiscourse');
});

test('the README does not carry the stock AI-cadence patterns either', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

  const banned = [
    [/a green tick requires/, 'not-X-but-Y contrast'],
    [/Zero blind spots/, 'a claim with no evidence'],
    [/\bstands as a testament\b/i, 'importance puffery'],
    [/\b(leverage|seamless|cutting-edge|game changer)\b/i, 'stock AI vocabulary'],
    [/it's worth noting/i, 'throat-clearing'],
  ];
  for (const [pattern, why] of banned) {
    assert.equal(pattern.test(readme), false, `README still carries ${why}: ${pattern}`);
  }
});

test('the architecture diagram only claims what the code does', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const doc = readFileSync(join(process.cwd(), 'docs', 'ARCHITECTURE.md'), 'utf8');
  const gateway = readFileSync(join(process.cwd(), 'apps', 'gateway', 'src', 'index.js'), 'utf8');
  const core = readFileSync(join(process.cwd(), 'packages', 'core', 'src', 'config.js'), 'utf8');

  // the diagram says the vault is opened at startup behind the gate — check that
  assert.match(doc, /gate -->\|"open: decrypt at startup"\| vault/);
  assert.match(gateway, /if \(config\.paidTiers\?\.enabled\)/, 'the gate must be the branch that opens the vault');
  assert.match(gateway, /openVaultForStartup/);
  // and that the router consults the gate rather than the vault
  assert.match(doc, /router -\.->\|"I4: is this paid\?"\| gate/);
  assert.match(core, /export function isPaidProvider/);
});

/* ---------------------------- CI must run the gates that exist */

test('CI runs every harness the repository ships', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ci = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

  // a gate that only runs when someone remembers is not a gate
  for (const script of ['scripts/audit.mjs', 'scripts/adr-check.mjs', 'scripts/adr-gate.mjs', 'evals/run.mjs', 'scripts/soak.mjs', 'scripts/smoke-dashboard.mjs']) {
    assert.ok(ci.includes(script), `CI does not run ${script}`);
  }
});

test('the CI probe step cannot burn a timeout per endpoint', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ci = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

  // 29 endpoints with an 8s default and no egress is four minutes of nothing
  assert.match(ci, /probe --json --timeout \d+/);
});

test('every script the workflow runs exists', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ci = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

  const referenced = [...ci.matchAll(/node (scripts\/[\w.-]+\.mjs|evals\/[\w.-]+\.mjs|apps\/cli\/bin\/sui\.js)/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 5, 'the workflow should reference several scripts');
  for (const path of new Set(referenced)) {
    assert.ok(existsSync(join(process.cwd(), path)), `CI references ${path}, which does not exist`);
  }
});

test('the workflow uses no expression GitHub rejects', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ci = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

  // GitHub does not expose `secrets` to a job-level `if`, and using it there
  // makes the whole workflow invalid: the run completes with zero jobs and no
  // error anyone reads. This file did exactly that for four days.
  const jobBlocks = ci.split(/\n  [a-z-]+:\n/).slice(1);
  for (const block of jobBlocks) {
    const jobIf = /^\s{4}if: .*secrets\./m.test(block);
    assert.equal(jobIf, false, 'a job-level `if` cannot reference secrets — move the check onto the step');
  }

  // and every secrets reference must still be a real expression
  for (const m of ci.matchAll(/\$\{\{([^}]+)\}\}/g)) {
    assert.match(m[1].trim(), /^(secrets|github|env|matrix|needs)\./, `unexpected expression: ${m[1]}`);
  }
});

test('the test script runs on every Node version, not just the one in the sandbox', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

  // `node --test test/` works on Node 20 and fails on Node 22, which reads the
  // argument as a file. The runner passes explicit paths, which both understand
  // and which cmd.exe can also handle — a glob would depend on the shell.
  assert.equal(pkg.scripts.test, 'node scripts/test.mjs');
  const runner = readFileSync(join(process.cwd(), 'scripts', 'test.mjs'), 'utf8');
  assert.match(runner, /readdirSync\(TEST_DIR\)/);
  assert.match(runner, /endsWith\('\.test\.js'\)/);
  // extra arguments must still be forwarded, after the force-exit flag
  assert.match(runner, /\.\.\.process\.argv\.slice\(2\), \.\.\.files/, 'extra arguments must be forwarded');
  assert.match(runner, /test-force-exit/, 'a leaked handle must not make CI look like it is still working');
  // a hang must name the test that hung, not hold the job open
  assert.match(runner, /--test-timeout=/, 'a per-test timeout is what turns a hang into a diagnosis');
  // files run concurrently and each starts gateways and spawns CLIs; a two-core
  // runner cannot run thirty of those at once without one file starving
  assert.match(runner, /--test-concurrency=/, 'concurrency must be bounded for a two-core runner');
});

test('every CI job has a timeout, so a hang fails instead of waiting', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ci = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

  // a leaked handle made the test job sit at "in progress" for fifteen minutes
  // and would have sat there for six hours. Scope the search to the jobs block:
  // `on: push:` is not a job, and matching it made the first version of this test
  // fail on its own regex.
  const jobsBlock = ci.slice(ci.indexOf('\njobs:'));
  const jobNames = [...jobsBlock.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
  assert.ok(jobNames.length >= 4, `expected several jobs, found ${jobNames.join(', ')}`);
  for (const job of jobNames) {
    const block = jobsBlock.split(new RegExp(`^  ${job}:$`, 'm'))[1]?.split(/^  [a-z-]+:$/m)[0] ?? '';
    assert.match(block, /timeout-minutes:/, `job "${job}" has no timeout`);
  }
});

test('no test starts a prober that reaches the network', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'test');

  // A unit test that probes the internet is fast here (no egress: every call is
  // refused instantly) and slow on a runner (egress: every call connects and
  // waits out the timeout). That asymmetry held CI for fifteen minutes.
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.js') && f !== 'docs.test.js')) {
    const body = readFileSync(join(dir, file), 'utf8');
    if (!body.includes('startWorkers: true')) continue;
    assert.match(
      body,
      /prober: \{ enabled: false \}/,
      `${file} starts workers with the prober on — that test will reach the network`,
    );
  }
});

test('no test writes to a pseudo-filesystem', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'test');

  // mkdirSync on /proc does not fail on a real Linux runner, it hangs — which
  // held a whole test file open until CI killed it, while passing here in
  // milliseconds. A read-only directory is unwritable everywhere.
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const body = readFileSync(join(dir, file), 'utf8');
    assert.equal(/['"]\/(proc|sys)\//.test(body), false, `${file} writes to a pseudo-filesystem`);
  }
});

test('every script in scripts/ parses', async () => {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = join(process.cwd(), 'scripts');

  // A multi-line string in a single-quoted literal is a syntax error, and nothing
  // ran this script between the edit that broke it and CI. `node --check` costs
  // milliseconds and would have caught it at commit time.
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', join(dir, file)], { stdio: 'pipe' });
    }, `scripts/${file} does not parse`);
  }
});

test('no gate depends on a tool the runner may not have', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'scripts');

  // `rg` is not installed on a GitHub runner, so an ADR check that shelled out to
  // it failed there and passed here — a gate that silently does not run.
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const body = readFileSync(join(dir, file), 'utf8');
    assert.equal(/'rg'|"rg"/.test(body), false, `scripts/${file} shells out to ripgrep`);
  }
});

test('publishing is automated, gated, and never needs a token on a laptop', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const path = join(process.cwd(), '.github', 'workflows', 'publish.yml');
  assert.ok(existsSync(path), 'the publish workflow is how this gets to npm without a local token');

  const wf = readFileSync(path, 'utf8');
  assert.match(wf, /tags: \['v\*'\]/, 'a tag is the trigger: publishing is permanent');
  assert.match(wf, /secrets\.NPM_TOKEN/, 'the token comes from a repository secret');
  assert.match(wf, /NODE_AUTH_TOKEN/, 'npm reads the token from NODE_AUTH_TOKEN');
  assert.match(wf, /npm test/, 'never publish something the gates have not passed');
  assert.match(wf, /publish\.mjs --dry-run/, 'the publisher checks everything before it writes');
  // a tag that disagrees with package.json would publish one version as another
  assert.match(wf, /does not match package.json version/);
});
