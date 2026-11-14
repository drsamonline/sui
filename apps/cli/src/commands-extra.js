/**
 * CLI commands that arrived with the kits: catalogue, vault, config editing,
 * the token audit, and compressed exports.
 *
 * Kept out of cli.js so the command table stays readable.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ConfigError, defaultConfigPath, normalizeConfig, sanitizeConfig, suiHome } from '@sui/core';
import { dedupeEntries, loadSeed, summarise } from '@sui/catalog';
import { loadKit, kitStatus } from '@sui/kits';
import { createVault } from '@sui/vault';
import { Prober, PROBE_FIXTURE_VERSION } from '@sui/prober';
import { table } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

/* ------------------------------------------------------------------ catalog */

/** `sui catalog [query]` — what Sui could route to, and what is still unverified. */
export function cmdCatalog(flags, args) {
  const entries = loadCatalogue();
  const summary = summarise(entries);

  if (flags.json) {
    console.log(JSON.stringify({ summary: { ...summary, rows: undefined }, rows: summary.rows }, null, 2));
    return;
  }

  const query = args[0] ?? flags.q;
  console.log('');
  console.log(`${summary.total} catalogue entries · ${summary.routable} routable · ${summary.awaiting_probe} awaiting a probe · ${summary.tos_avoid} tos:avoid`);
  console.log('');

  if (query) {
    const Search = loadKit('search-kit');
    const index = Search.index(
      entries.map((e) => ({ provider: e.provider, label: e.label, caps: e.capabilities.join(' ') })),
      { keys: ['provider', 'label', 'caps'] },
    );
    const hits = index.query(String(query)).slice(0, 10);
    if (!hits.length) {
      console.log(`Nothing in the catalogue matches "${query}".`);
      return;
    }
    console.log(
      table(
        ['provider', 'label', 'caps', 'score'],
        hits.map((h) => [h.item.provider, h.item.label, h.item.caps, h.score.toFixed(3)]),
      ),
    );
    console.log('');
    console.log('Every entry needs a probe before it can answer a request (see ROADMAP B2.3).');
    return;
  }

  const rows = summary.rows.slice(0, 40).map((e) => [
    e.provider,
    e.label,
    e.auth,
    e.tos,
    e.needs_probe ? 'awaiting probe' : 'verified',
    e.base_url ?? e.docs_url ?? '—',
  ]);
  console.log(table(['provider', 'label', 'auth', 'tos', 'state', 'where'], rows));
  if (summary.rows.length > rows.length) console.log(`\n… ${summary.rows.length - rows.length} more. Search with: sui catalog <query>`);
}

function loadCatalogue() {
  const seedPath = join(ROOT, 'packages', 'catalog', 'seed.json');
  const generatedPath = join(ROOT, 'packages', 'catalog', 'generated.json');
  const entries = [];
  if (existsSync(seedPath)) entries.push(...loadSeed(seedPath));
  if (existsSync(generatedPath)) entries.push(...loadSeed(generatedPath));
  return dedupeEntries(entries);
}

/* -------------------------------------------------------------------- vault */

export async function cmdVault(flags, args) {
  const sub = args[0] ?? 'status';
  const home = suiHome(process.env);
  const configPath = flags.config ?? defaultConfigPath();
  const raw = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const vaultPath = raw.paid_tiers?.vaultPath ?? join(home, 'vault.json');
  const vault = createVault({ path: vaultPath, env: process.env });

  if (sub === 'init') {
    const result = await vault.init({ force: Boolean(flags.force) });
    console.log('');
    if (!result.created) {
      console.log(`A vault already exists at ${vaultPath}. Use --force to replace it (that destroys the keys in it).`);
      return;
    }
    console.log(`Vault created: ${vaultPath}`);
    if (result.keyPath) {
      console.log(`Passphrase written to ${result.keyPath} (mode 0600).`);
      console.log('');
      console.log('This protects the vault file if it is copied or committed. It does not protect');
      console.log('you from someone who already has your user account. For that, set');
      console.log('SUI_VAULT_PASSPHRASE yourself and delete the key file.');
    }
    console.log('');
    console.log('Next: sui vault set openai');
    return;
  }

  if (sub === 'set') {
    const provider = args[1] ?? flags.provider;
    if (!provider) throw new ConfigError('Say which provider: sui vault set openai');
    const key = flags.key ?? (await readSecret(`Paste the ${provider} API key (input is echoed): `));
    if (!key) throw new ConfigError('No key given, so nothing was stored.');
    await vault.set(provider, key.trim());
    console.log(`Stored a key for "${provider}". Only the provider name is visible in the vault file; the key is sealed.`);
    return;
  }

  if (sub === 'remove') {
    const provider = args[1] ?? flags.provider;
    if (!provider) throw new ConfigError('Say which provider: sui vault remove openai');
    const removed = await vault.remove(provider);
    console.log(removed ? `Removed "${provider}".` : `No key stored for "${provider}".`);
    return;
  }

  if (sub === 'list') {
    const providers = await vault.list();
    console.log('');
    console.log(providers.length ? providers.join('\n') : 'The vault is empty.');
    return;
  }

  // status
  console.log('');
  console.log(`path        ${vaultPath}`);
  console.log(`exists      ${vault.exists() ? 'yes' : 'no'}`);
  console.log(`passphrase  ${vault.source === 'env' ? 'from SUI_VAULT_PASSPHRASE' : vault.source === 'keyfile' ? `key file (${vault.keyPath})` : 'not found'}`);
  if (vault.exists()) {
    try {
      const keys = await vault.list();
      console.log(`providers   ${keys.length ? keys.join(', ') : '(none)'}`);
    } catch (err) {
      console.log(`providers   could not open: ${/** @type {any} */ (err).message}`);
    }
  }
  console.log(`gate        ${raw.paid_tiers?.enabled === true ? 'OPEN (paid credentials load)' : 'closed (paid credentials are never read)'}`);
  if (raw.paid_tiers?.enabled !== true) {
    console.log('');
    console.log('Set paid_tiers.enabled = true in the config before a sealed key can be used:');
    console.log('  sui config set paid_tiers.enabled true');
  }
}

async function readSecret(question) {
  if (!stdin.isTTY) {
    // piped input: read one line from stdin
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------- config */

export function cmdConfig(flags, args) {
  const path = flags.config ?? defaultConfigPath();
  if (!path) throw new ConfigError('No config found. Run `npx sui init` first.');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const sub = args[0] ?? 'show';
  const dotted = args[1];

  if (sub === 'show' || sub === undefined) {
    console.log(JSON.stringify(sanitizeConfig(normalizeConfig(raw, { path, env: process.env })), null, 2));
    return;
  }

  if (sub === 'get') {
    if (!dotted) throw new ConfigError('Usage: sui config get <path>   e.g. sui config get budgets.dailyUsd');
    const value = getPath(raw, dotted);
    if (value === undefined) {
      console.log(`${dotted} is not set.`);
      process.exitCode = 1;
      return;
    }
    console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    return;
  }

  if (sub === 'set' || sub === 'unset') {
    if (!dotted) throw new ConfigError(`Usage: sui config ${sub} <path> [value]`);
    const before = getPath(raw, dotted);
    if (sub === 'unset') deletePath(raw, dotted);
    else {
      const value = parseValue(args.slice(2).join(' '));
      setPath(raw, dotted, value);
    }

    // Validate the whole config before writing: a set that breaks the gateway is
    // refused here, with the same message `sui start` would give.
    try {
      normalizeConfig(raw, { path, env: process.env });
    } catch (err) {
      throw new ConfigError(
        `That change would break the config, so nothing was written.\n\n${/** @type {any} */ (err).message}`,
        { path },
      );
    }

    copyFileSync(path, `${path}.bak-${Date.now()}`);
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
    const after = getPath(raw, dotted);
    console.log(`${dotted}: ${format(before)} → ${format(after)}`);
    console.log('Written. Restart `sui start` to pick it up.');
    return;
  }

  throw new ConfigError(`Unknown: sui config ${sub}. Try show, get, set, unset.`);
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const k of parts.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const k of parts.slice(0, -1)) {
    if (cur == null) return;
    cur = cur[k];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function parseValue(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function format(v) {
  if (v === undefined) return '(unset)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/* ------------------------------------------------------------------- tokens */

/**
 * `sui tokens --check` — WCAG 2.2 AA on the dashboard's own tokens, computed with
 * the vendored tokens-kit's contrast maths rather than a hand-waved claim (I9).
 */
export function cmdTokens(flags) {
  const html = readFileSync(join(ROOT, 'apps', 'dashboard', 'web', 'dashboard.html'), 'utf8');
  const Tokens = loadKit('tokens-kit');

  const darkStart = html.indexOf('prefers-color-scheme: dark');
  const light = readTokenBlock(darkStart > 0 ? html.slice(0, darkStart) : html, ':root', 0);
  const dark = darkStart > 0 ? readTokenBlock(html.slice(darkStart), ':root', 0) : {};

  const pairs = [
    ['text on bg', 'text', 'bg', 4.5],
    ['text on surface', 'text', 'surface', 4.5],
    ['dim text on bg', 'text-dim', 'bg', 4.5],
    ['dim text on surface', 'text-dim', 'surface', 4.5],
    ['dim text on surface-2', 'text-dim', 'surface-2', 4.5],
    ['accent on surface', 'accent', 'surface', 4.5],
    ['on-accent on accent', 'on-accent', 'accent', 4.5],
    ['line on surface (UI)', 'line-strong', 'surface', 3],
  ];

  let failures = 0;
  const report = [];
  for (const [label, fg, bg, min] of pairs) {
    for (const [mode, tokens] of [['light', light], ['dark', dark]]) {
      const a = tokens[fg];
      const b = tokens[bg];
      if (!a || !b) continue;
      const ratio = Tokens.contrast(a, b);
      const ok = ratio >= min;
      if (!ok) failures += 1;
      report.push([mode, label, `${a} on ${b}`, ratio.toFixed(2), `≥ ${min}`, ok ? 'pass' : 'FAIL']);
    }
  }

  console.log('');
  console.log('Token contrast — WCAG 2.2 AA, computed by tokens-kit');
  console.log('');
  console.log(table(['mode', 'pair', 'values', 'ratio', 'needs', 'result'], report));

  const kitTokens = Tokens.tokens('light');
  console.log('');
  console.log(`The kit's palette is available for future tokens: ${Object.keys(kitTokens?.colors ?? kitTokens ?? {}).length} colour names.`);
  console.log(failures ? `\n${failures} pair(s) below AA. Fix the token, not the test.` : '\nAll pairs pass.');
  if (failures) process.exitCode = 1;
}

/** Every `:root { … }` block, brace-matched so indentation cannot hide one. */
function readTokenBlock(source, _selector, _index) {
  const out = {};
  const start = /:root\s*\{/g;
  let m;
  while ((m = start.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    const body = source.slice(from, i - 1);
    for (const line of body.split('\n')) {
      const tok = line.match(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/);
      if (tok) out[tok[1]] = tok[2];
    }
  }
  return out;
}

/* -------------------------------------------------------------------- kits */

export function cmdKits(flags) {
  const status = kitStatus();
  console.log('');
  console.log('Vendored kits (vendor/kits)');
  console.log('');
  console.log(
    table(
      ['kit', 'state', 'version'],
      status.map((k) => [k.name, k.loaded ? 'loaded' : `failed: ${k.error}`, k.version ?? '—']),
    ),
  );
  console.log('');
  console.log('Licence: each kit carries its own LICENSE in vendor/kits/. See docs/legal/LICENSE_INVENTORY.md.');
}

/* ------------------------------------------------------------------- probe */

/**
 * `sui probe [provider] [--interval <ms>]` — the canary prober (B2.3).
 *
 * Only entries with a base_url can be probed; the rest are identities, and the
 * report says so rather than inventing a result.
 */
export async function cmdProbe(flags, args) {
  const entries = loadCatalogue();
  const wanted = args[0] ?? flags.provider;
  const selected = wanted ? entries.filter((e) => e.provider === wanted) : entries;

  if (!selected.length) {
    throw new ConfigError(`No catalogue entry called "${wanted}". Run \`sui catalog\` for the list.`);
  }

  const probeable = selected.filter((e) => e.base_url);
  const identities = selected.filter((e) => !e.base_url);

  console.log('');
  console.log(`Probing ${probeable.length} of ${selected.length} entries (fixtures v${PROBE_FIXTURE_VERSION})`);
  if (identities.length) {
    console.log(`${identities.length} have no base_url yet — an identity is not an endpoint, so they are not probed.`);
  }
  console.log('');

  const prober = new Prober({ entries: probeable, timeoutMs: Number(flags.timeout ?? 8000) });
  const results = await prober.runOnce();

  if (flags.json) {
    console.log(JSON.stringify({ fixtureVersion: PROBE_FIXTURE_VERSION, results, state: prober.snapshot() }, null, 2));
    return;
  }

  if (!results.length) {
    console.log('Nothing to probe. Add a base_url to a catalogue entry, or run `sui catalog` to see what is waiting.');
    return;
  }

  const rows = results.map((r) => [
    r.provider,
    r.ok ? 'ok' : 'fail',
    r.levels.liveness?.ok ? 'yes' : 'no',
    r.levels.readiness?.ok ? 'yes' : 'no',
    Object.entries(r.levels.suitability).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'no'}`).join(' ') || '—',
    `${r.latencyMs} ms`,
    r.reasons.length ? r.reasons.join('; ').slice(0, 60) : '',
  ]);
  console.log(table(['provider', 'result', 'live', 'ready', 'suitable', 'latency', 'why not'], rows));

  const ok = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`${ok} of ${results.length} probed entries are verified.`);
  if (!ok) {
    console.log('Nothing is routable yet. That is the honest state, not a bug: a route becomes verified by answering.');
  }
}

/* ------------------------------------------------------------------ exports */

/** `sui cost --export usage.csv [--gzip]` — compressed with compress-kit. */
export async function writeExport({ ledger, file, format, gzip }) {
  const body = format === 'json' ? JSON.stringify(ledger.aggregate({ since: 0 }), null, 2) : ledger.csv();
  const target = file ?? `sui-usage.${format === 'json' ? 'json' : 'csv'}`;
  mkdirSync(dirname(target), { recursive: true });

  if (!gzip) {
    writeFileSync(target, body);
    console.log(`Wrote ${target} (${body.length} bytes).`);
    return;
  }

  const Compress = loadKit('compress-kit');
  // gzip, not compressString: that one hands back base64, and a .gz file has to
  // be real gzip bytes so gunzip(1) can read it.
  const bytes = await Compress.gzip(Compress.bytes.fromText(body));
  const gzPath = `${target}.gz`;
  writeFileSync(gzPath, Buffer.from(bytes));
  console.log(`Wrote ${gzPath} (${body.length} bytes → ${bytes.length} bytes, ${Math.round(Compress.ratio(body.length, bytes.length) * 100)}%).`);
  console.log('Read it back with: gunzip -c ' + gzPath);
}
