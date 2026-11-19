#!/usr/bin/env node
/**
 * B2.2 — the catalogue sync worker, in the only form that can be honest offline.
 *
 * A sync worker normally fetches five sources, parses them, and merges what
 * changed. That needs egress, which a gateway should not depend on to start. So
 * this worker does the part that matters and does it locally:
 *
 *   1. **audit** the ledger in packages/catalog/sources.json — every source must
 *      name a licence, a pinned commit and what was taken from it;
 *   2. **check staleness** against the seed: an entry whose note cites a source
 *      that no longer appears in the ledger is an orphan;
 *   3. **report what a live sync would do**, per source, without fetching.
 *
 * With `--online` it will additionally ask GitHub for each source's current HEAD
 * and report which pins have moved. It never rewrites the seed from the network:
 * a URL that changes upstream should be a deliberate update with a human looking
 * at the diff, not a silent drift in a background job.
 *
 * Run: node scripts/sync-catalog.mjs [--online] [--json]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const online = process.argv.includes('--online');
const asJson = process.argv.includes('--json');

const ledger = JSON.parse(readFileSync(join(ROOT, 'packages', 'catalog', 'sources.json'), 'utf8'));
const seed = JSON.parse(readFileSync(join(ROOT, 'packages', 'catalog', 'seed.json'), 'utf8'));

const problems = [];
const ids = ledger.sources.map((s) => s.id);

// ---- 1. the ledger is complete -------------------------------------------
for (const source of ledger.sources) {
  // A repository is pinned by a commit. A site read on a date has no commit, so the
  // date is the pin — and it may contribute facts only, which the licence field and
  // the notTaken line have to say.
  const isRepo = /^https:\/\/github\.com\//.test(source.url ?? '');
  if (!source.url || !/^https:\/\//.test(source.url)) problems.push(`${source.id}: no usable url`);
  if (isRepo) {
    if (!/^[0-9a-f]{7}$/.test(source.commit ?? '')) problems.push(`${source.id}: commit is not pinned`);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(source.read ?? '')) {
    problems.push(`${source.id}: not a repository, so it needs the date it was read`);
  }
  if (!source.licence) problems.push(`${source.id}: no licence recorded`);
  if (!source.taken) problems.push(`${source.id}: does not say what was taken`);
  if (!source.notTaken) problems.push(`${source.id}: does not say what was not taken`);
}

// ---- 2. entries cite sources that exist ----------------------------------
const citedBy = new Map(ids.map((id) => [id, 0]));
const orphans = [];
for (const entry of seed.entries) {
  const note = entry.notes ?? '';
  const cited = ids.filter((id) => note.includes(id));
  // "not imported from a third party" is the opposite of an import; matching it
  // as one flagged every first-party endpoint as an orphan
  const looksImported = /recorded by|imported from/i.test(note) && !/not imported/i.test(note);
  if (!cited.length && looksImported) {
    orphans.push(entry.provider);
    continue;
  }
  for (const id of cited) citedBy.set(id, (citedBy.get(id) ?? 0) + 1);
}
if (orphans.length) problems.push(`entries cite a source that is not in the ledger: ${orphans.join(', ')}`);

// ---- 3. what a live sync would do ----------------------------------------
const rows = ledger.sources.map((source) => ({
  id: source.id,
  commit: source.commit,
  licence: source.licence,
  entries: citedBy.get(source.id) ?? 0,
  status: 'pinned',
}));

// ---- 4. optionally ask GitHub whether the pin still matches ---------------
if (online) {
  for (const row of rows) {
    const source = ledger.sources.find((s) => s.id === row.id);
    const repo = source.url.replace('https://github.com/', '');
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'sui-catalog-sync' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        row.status = `unreachable (HTTP ${res.status})`;
        continue;
      }
      const json = await res.json();
      const head = String(json?.[0]?.sha ?? '').slice(0, 7);
      row.status = head === source.commit ? 'current' : `moved → ${head}`;
    } catch (err) {
      row.status = `unreachable (${err?.name ?? err})`;
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ sources: rows, problems, entries: seed.entries.length }, null, 2));
} else {
  console.log('');
  console.log(`Catalogue sync — ${rows.length} source(s), ${seed.entries.length} entries`);
  console.log('');
  for (const row of rows) {
    console.log(`  ${row.id.padEnd(24)} ${row.commit}  ${String(row.entries).padStart(2)} entr(y/ies)  ${row.status}`);
  }
  if (!online) {
    console.log('');
    console.log('  Offline: pins were not checked against GitHub. Add --online to compare them.');
  }
  console.log('');
  if (problems.length) {
    console.log('  Problems:');
    for (const problem of problems) console.log(`   - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('  Ledger and seed agree. Nothing to do.');
  }
  console.log('');
}
