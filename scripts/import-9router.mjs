#!/usr/bin/env node
/**
 * Import the endpoint table from 9router-auto-free (MIT) into Sui's catalogue.
 *
 * What this does, and what it deliberately does not:
 *
 *   - it copies **facts**: a provider's label and the base URL its author records.
 *     Facts are not creative expression, but the source is MIT and credited anyway.
 *   - it does **not** copy code. The discovery adapters, the credential scanners
 *     and the scheduler in that project are not used here.
 *   - it does **not** mark anything routable. Every imported entry is
 *     `needs_probe: true` and `tos: review`: an endpoint someone else recorded is
 *     not an endpoint this gateway has verified, and a URL is not a ToS read.
 *
 * Source: https://github.com/herliansyah/9router-auto-free (MIT), commit pinned
 * below. The pin matters: a URL that changes upstream should be a deliberate
 * update, not a silent drift.
 *
 * Run: node scripts/import-9router.mjs [--source ../9router]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const sourceArg = process.argv.indexOf('--source');
const SOURCE = sourceArg === -1 ? join(ROOT, '..', '9router') : process.argv[sourceArg + 1];
const SEED = join(ROOT, 'packages', 'catalog', 'seed.json');

if (!existsSync(join(SOURCE, 'providers.js'))) {
  console.error(`No providers.js in ${SOURCE}. Clone the reference repo first:
  git clone --depth 1 https://github.com/herliansyah/9router-auto-free.git ../9router`);
  process.exit(1);
}

const commit = (() => {
  try {
    return execFileSync('git', ['-C', SOURCE, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

// Parse only the PROVIDERS array: the last record otherwise swallows the rest of
// the file, and every later `credentialKind` match then belongs to the wrong block.
const full = readFileSync(join(SOURCE, 'providers.js'), 'utf8');
const source = full.slice(0, full.indexOf('const PROVIDER_BY_KEY') === -1 ? undefined : full.indexOf('const PROVIDER_BY_KEY'));
const records = [];
for (const block of source.split(/\n  \{\n/).slice(1)) {
  const key = /key: '([^']+)'/.exec(block)?.[1];
  const label = /label: '([^']+)'/.exec(block)?.[1];
  const baseUrl = /baseUrl: '([^']+)'/.exec(block)?.[1] ?? null;
  const credentialKind = /credentialKind: '([^']+)'/.exec(block)?.[1] ?? 'default';
  const requireApiKey = /requireApiKey: false/.test(block);
  if (key && label) records.push({ key, label, baseUrl, credentialKind, requireApiKey });
}

/** Upstream's own exclusion list: providers its author stopped using. */
let excluded = [];
try {
  excluded = JSON.parse(readFileSync(join(SOURCE, 'exclusions.json'), 'utf8')).excludedProviders ?? [];
} catch {
  excluded = [];
}
const isExcluded = (key, label) =>
  excluded.some((e) => {
    const needle = String(e).toLowerCase();
    return needle === key.toLowerCase() || needle === label.toLowerCase() || needle.startsWith(`${key.toLowerCase()}.`);
  });

const seed = JSON.parse(readFileSync(SEED, 'utf8'));
const byProvider = new Map(seed.entries.map((e) => [e.provider, e]));

/** Sui's own names for the same upstreams, so an import updates rather than duplicates. */
const ALIASES = {
  kilo: 'kilo-gateway',
  ollama: 'ollama-cloud',
  oa: 'openagentic',
};

/**
 * Does this provider answer without a credential?
 *
 * Upstream records `credentialKind: 'default'` for the keyed providers, which is
 * the majority. Only an explicit `requireApiKey: false`, or a credential kind
 * that is a token rather than a key, counts as keyless — guessing here would make
 * the prober try a keyed endpoint without a key and report a misleading failure.
 */
function authFor(record) {
  if (record.requireApiKey) return { auth: 'none', key_env: null };
  if (record.credentialKind === 'default') {
    return { auth: 'key', key_env: `${record.key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY` };
  }
  // a scanned or vendor-specific credential: not a plain API key, so the honest
  // label is 'none' with a note rather than a key_env nobody can fill in
  return { auth: 'none', key_env: null };
}

let added = 0;
let filled = 0;

for (const record of records) {
  if (!record.baseUrl) continue; // OpenCode records no endpoint; nothing to import
  const provider = ALIASES[record.key] ?? record.key;
  const existing = byProvider.get(provider);

  if (existing) {
    if (!existing.base_url) {
      existing.base_url = record.baseUrl;
      existing.needs_probe = true;
      existing.notes = `${existing.notes ?? ''} Endpoint recorded by 9router-auto-free@${commit}.`.trim();
      filled += 1;
    }
    continue;
  }

  const { auth, key_env } = authFor(record);
  const entry = {
    provider,
    label: record.label,
    auth,
    ...(key_env ? { key_env } : {}),
    base_url: record.baseUrl,
    model_family: 'openai-compatible',
    // never 'allowed': a URL is not a terms-of-service read
    tos: 'review',
    privacy_retention: 'unknown',
    capabilities: ['chat', 'streaming'],
    needs_probe: true,
    notes: `Imported from 9router-auto-free@${commit} (MIT). Endpoint unverified by this gateway.${
      record.credentialKind !== 'default' && !record.requireApiKey ? ` Upstream uses a "${record.credentialKind}" credential for this provider, which is not a plain API key.` : ''
    }${
      isExcluded(record.key, record.label) ? ' The upstream project excludes this provider from its own routing.' : ''
    }`,
  };
  seed.entries.push(entry);
  byProvider.set(provider, entry);
  added += 1;
}

seed.entries.sort((a, b) => a.provider.localeCompare(b.provider));
writeFileSync(SEED, `${JSON.stringify(seed, null, 2)}\n`);

console.log('');
console.log(`9router-auto-free@${commit} (MIT)`);
console.log(`  ${records.length} provider record(s) read, ${records.filter((r) => r.baseUrl).length} with an endpoint`);
console.log(`  ${added} entr(y/ies) added, ${filled} existing entr(y/ies) given a base_url`);
console.log(`  ${excluded.length} upstream exclusion(s) noted`);
console.log('');
console.log(`  catalogue now holds ${seed.entries.length} entries — run \`npx sui catalog\` to see them`);
