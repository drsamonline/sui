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
