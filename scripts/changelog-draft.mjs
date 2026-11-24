#!/usr/bin/env node
/**
 * Draft a CHANGELOG entry from commit subjects — and only draft it.
 *
 * This repository's changelog is hand-written on purpose. Two of its four
 * sections cannot come from a commit log:
 *
 *   ### Known gaps          what this version does not do, which is a judgement
 *   ### Verified at this version   the gate output, which must be read, not inferred
 *
 * Those two have been wrong before, and a generator that filled them would
 * replace a judgement with a list of commit subjects that reads like one. So this
 * drafts the mechanical half — Added and Fixed — and prints the other two as
 * TODO blocks, which means the draft cannot be pasted as a finished entry.
 *
 * It prints to stdout and writes nothing. `sui`'s own release path edits
 * CHANGELOG.md by hand, and a tool that quietly rewrote it would be a tool that
 * could rewrite the part a human was supposed to check.
 *
 *   node scripts/changelog-draft.mjs                    # since the last tag
 *   node scripts/changelog-draft.mjs --from v0.12.36    # an explicit range
 *   node scripts/changelog-draft.mjs --version 0.12.48  # name the heading
 */

import { execFileSync } from 'node:child_process';

/** Conventional-commit type → the heading it lands under. */
const SECTIONS = [
  { type: 'feat', heading: '### Added' },
  { type: 'fix', heading: '### Fixed' },
  { type: 'perf', heading: '### Changed' },
  { type: 'refactor', heading: '### Changed' },
  { type: 'docs', heading: '### Docs' },
];

/**
 * Group subjects by type. Anything that is not a conventional commit is counted
 * and dropped rather than guessed at: "merge branch main" is not a change a user
 * can act on, and inventing a heading for it is how a changelog starts lying.
 *
 * @param {Array<{sha: string, subject: string}>} commits
 * @returns {{sections: Array<{heading: string, items: Array<{sha: string, text: string}>}>, skipped: Array<{sha: string, subject: string}>}}
 */
export function groupCommits(commits) {
  /** @type {Map<string, Array<{sha: string, text: string}>>} */
  const byHeading = new Map();
  for (const section of SECTIONS) byHeading.set(section.heading, []);
  const skipped = [];

  for (const commit of commits) {
    const match = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(String(commit.subject ?? '').trim());
    if (!match) {
      skipped.push(commit);
      continue;
    }
    const section = SECTIONS.find((s) => s.type === match[1]);
    if (!section) {
      skipped.push(commit);
      continue;
    }
    byHeading.get(section.heading).push({ sha: commit.sha.slice(0, 7), text: match[2] });
  }

  return {
    // a heading with nothing under it is noise in a draft
    sections: [...byHeading.entries()].filter(([, items]) => items.length).map(([heading, items]) => ({ heading, items })),
    skipped,
  };
}

/**
 * The draft, as markdown.
 *
 * The two sections this cannot fill are printed as TODOs on purpose. A draft that
 * looked complete is a draft somebody pastes.
 *
 * @param {Array<{sha: string, subject: string}>} commits
 * @param {{version?: string, date?: string}} [opts]
 */
export function draft(commits, opts = {}) {
  const version = opts.version ?? 'x.y.z';
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const { sections, skipped } = groupCommits(commits);

  const lines = [];
  lines.push(`## ${version} — ${date}`);
  lines.push('');

  if (!sections.length) {
    lines.push('<!-- no conventional commits in this range: write the entry by hand -->');
    lines.push('');
  }

  for (const section of sections) {
    lines.push(section.heading);
    lines.push('');
    for (const item of section.items) lines.push(`- ${item.text} (${item.sha})`);
    lines.push('');
  }

  lines.push('### Known gaps');
  lines.push('');
  lines.push('<!-- a human writes this: what this version does not do, and why -->');
  lines.push('- TODO');
  lines.push('');
  lines.push('### Verified at this version');
  lines.push('');
  lines.push('<!-- fill from the gate output you actually read; do not infer a number -->');
  lines.push('| Gate | Result |');
  lines.push('|---|---|');
  lines.push('| `npm test` | TODO |');
  lines.push('| `npm run audit` | TODO |');
  lines.push('| `npm run adr:check` | TODO |');
  lines.push('| `node scripts/verify-published.mjs` | TODO |');
  lines.push('');

  if (skipped.length) {
    lines.push(`<!-- ${skipped.length} commit(s) not conventional, left out: ${skipped.map((s) => s.sha.slice(0, 7)).join(', ')} -->`);
    lines.push('');
  }

  return lines.join('\n');
}

/* --------------------------------------------------------------------- cli */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function lastTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

if (process.argv[1] && process.argv[1].endsWith('changelog-draft.mjs')) {
  const from = arg('from', lastTag());
  const to = arg('to', 'HEAD');
  const range = from ? `${from}..${to}` : to;

  let raw = '';
  try {
    raw = execFileSync('git', ['log', '--no-merges', '--format=%h%x09%s', range], { encoding: 'utf8' });
  } catch (err) {
    console.error(`Could not read git history for ${range}: ${/** @type {any} */ (err).message}`);
    process.exit(1);
  }

  const commits = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t') };
    });

  console.log('');
  console.log(`  ${commits.length} commit(s) in ${range}`);
  console.log('  Draft only — nothing was written to CHANGELOG.md.');
  console.log('');
  console.log(draft(commits, { version: arg('version', 'x.y.z') }));

  const skipped = groupCommits(commits).skipped.length;
  if (skipped) console.error(`  ${skipped} commit(s) were not conventional and were left out.`);
}
