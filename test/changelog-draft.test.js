import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draft, groupCommits } from '../scripts/changelog-draft.mjs';

/**
 * The changelog is hand-written on purpose. This tool drafts the mechanical half
 * and refuses the other half — the part that has been wrong before.
 */

const commit = (sha, subject) => ({ sha, subject });

test('commits are grouped by type, and anything not conventional is counted', () => {
  const { sections, skipped } = groupCommits([
    commit('aaaaaaa1', 'feat: add a thing'),
    commit('aaaaaaa2', 'fix(scope): repair a thing'),
    commit('aaaaaaa3', 'docs: explain a thing'),
    commit('aaaaaaa4', 'Merge branch main'),
    commit('aaaaaaa5', 'chore: bump something'),
    commit('aaaaaaa6', 'feat!: breaking but still a feature'),
  ]);

  const added = sections.find((s) => s.heading === '### Added');
  assert.equal(added.items.length, 2, 'both feats land under Added, breaking or not');
  assert.equal(added.items[0].text, 'add a thing', 'the type prefix is stripped');
  assert.equal(added.items[1].text, 'breaking but still a feature');

  assert.equal(sections.find((s) => s.heading === '### Fixed').items[0].text, 'repair a thing');
  assert.equal(skipped.length, 2, 'a merge and a chore are dropped, not guessed at');
});

test('an empty heading is left out rather than printed empty', () => {
  const { sections } = groupCommits([commit('aaaaaaa1', 'fix: only a fix')]);
  assert.deepEqual(
    sections.map((s) => s.heading),
    ['### Fixed'],
  );
});

test('the draft leaves the two judgement sections as TODOs', () => {
  const text = draft([commit('aaaaaaa1', 'feat: something')], { version: '9.9.9', date: '2026-01-01' });

  assert.match(text, /^## 9\.9\.9 — 2026-01-01$/m);
  assert.match(text, /- something \(aaaaaaa\)/);
  // the two sections a commit log cannot fill, and cannot pretend to
  assert.match(text, /### Known gaps\n\n<!-- a human writes this/);
  assert.match(text, /### Verified at this version\n\n<!-- fill from the gate output/);
  assert.match(text, /\| `npm test` \| TODO \|/, 'a number nobody read must not appear');
});

test('a range with nothing conventional says so instead of printing an empty entry', () => {
  const text = draft([commit('aaaaaaa1', 'Merge branch main')]);
  assert.match(text, /no conventional commits in this range/);
  assert.match(text, /not conventional, left out: aaaaaaa/, 'and names what it skipped');
});

test('running it writes nothing: CHANGELOG.md is unchanged', () => {
  // A throwaway repository, because the alternative is depending on this
  // checkout's tags and depth — and CI checks out shallow, where the tag this test
  // named did not exist. It passed here and failed there, which is the whole
  // reason a test should not read the history it happens to be sitting in.
  const dir = mkdtempSync(join(tmpdir(), 'sui-changelog-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=draft', '-c', 'user.email=draft@example', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
  for (const [file, subject] of [
    ['a.txt', 'feat: a feature'],
    ['b.txt', 'fix: a fix'],
    ['c.txt', 'Merge branch main'],
  ]) {
    writeFileSync(join(dir, file), file);
    git('add', '-A');
    git('commit', '-qm', subject);
  }

  const out = execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'changelog-draft.mjs'), '--to', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), '# Changelog\n', 'a draft tool that rewrites the changelog is a tool that can rewrite a judgement');
  assert.match(out, /Draft only — nothing was written/);
  assert.match(out, /### Added\n\n- a feature/);
  assert.match(out, /### Fixed\n\n- a fix/);
  assert.match(out, /1 commit\(s\) not conventional|not conventional, left out/);
});
