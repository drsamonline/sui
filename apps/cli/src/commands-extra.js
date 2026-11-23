/**
 * CLI commands that arrived with the kits: catalogue, vault, config editing,
 * the token audit, and compressed exports.
 *
 * Kept out of cli.js so the command table stays readable.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ConfigError, defaultConfigPath, normalizeConfig, sanitizeConfig, suiHome } from '@drsamonline/core';
import { applyVerified, freeBudget, formatTokens } from '@drsamonline/catalog';
import { dedupeEntries, loadSeed, summarise } from '@drsamonline/catalog';
import { loadKit, kitStatus } from '@drsamonline/kits';
import { createVault } from '@drsamonline/vault';
import { DEFAULT_PROBE_CONCURRENCY, Prober, PROBE_FIXTURE_VERSION } from '@drsamonline/prober';
import { explainPlan } from '@drsamonline/router';
import { createGateway } from '@drsamonline/gateway';
import { TRANSFORMS, runSelfTest } from '@drsamonline/redteam';
import { createHttpHandler, createMcpServer, runStdio, SUPPORTED_PROTOCOL_VERSIONS } from '@drsamonline/mcp';

/** Read from package.json so the banner and the package cannot disagree. */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
import { PRESETS, RecallStore, choosePreset, compress } from '@drsamonline/compression';
import { emitJson, table } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

/* ------------------------------------------------------------------ catalog */

/** `sui catalog [query]` — what Sui could route to, and what is still unverified. */
/**
 * `sui free-budget` — how much free headroom you actually have.
 *
 * Two numbers, never added together: what a probe reached, and what is only a
 * claim. A pool counted once however many names point at it.
 */
export function cmdFreeBudget(flags) {
  const entries = loadCatalogue();
  const probes = Object.fromEntries(readVerified().map((v) => [v.pool_key, v]));
  const budget = freeBudget(entries, probes);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          verifiedTokens: budget.verifiedTokens,
          unverifiedTokens: budget.unverifiedTokens,
          verified: budget.verified,
          unverified: budget.unverified,
          pools: budget.pools,
          withoutBudget: budget.withoutBudget,
          note: budget.note,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  console.log(`  ${formatTokens(budget.verifiedTokens)} verified per month   ← pools that answered a probe`);
  console.log(`  ${formatTokens(budget.unverifiedTokens)} published, unverified   ← never added to the line above`);
  console.log('');
  console.log(
    table(
      ['pool', 'names', 'tokens/mo', 'state'],
      [
        ...budget.verified.map((p) => [p.pool_key.slice(0, 34), p.names.join(', '), formatTokens(p.tokens), 'verified']),
        ...budget.unverified.map((p) => [p.pool_key.slice(0, 34), p.names.join(', '), formatTokens(p.tokens), 'unverified']),
      ],
    ),
  );
  console.log('');
  console.log(`  ${budget.pools} pool(s) · ${budget.withoutBudget} with no published budget recorded`);
  console.log(`  ${budget.note}`);
  console.log('');
}

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

/**
 * Where observations live.
 *
 * Seed entries ship with the package — they are imported facts. What *this*
 * machine observed belongs in the user's home, not in the package: writing into
 * an installed `node_modules` would be wrong, and a verification made on one
 * machine is not evidence for another.
 */
function verifiedPath() {
  return join(suiHome(), 'catalog-verified.json');
}

/** The old in-repo location, still read so a development clone keeps its state. */
function legacyVerifiedPath() {
  return join(ROOT, 'packages', 'catalog', 'verified.json');
}

function readVerified() {
  for (const path of [verifiedPath(), legacyVerifiedPath()]) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed.entries) && parsed.entries.length) return parsed.entries;
    } catch {
      /* a corrupt overlay must not stop the catalogue loading */
    }
  }
  return [];
}

/**
 * Where the catalogue lives.
 *
 * From this repository it is packages/catalog/seed.json. From an npm install there
 * is no repository: the file travels inside @drsamonline/catalog, and reading it
 * from a repo-relative path reported "0 catalogue entries" — so `sui probe --write`
 * had nothing to probe and `sui catalog` showed an empty table to every user who
 * installed the package.
 */
function cataloguePaths() {
  const candidates = [join(ROOT, 'packages', 'catalog', 'seed.json')];
  try {
    candidates.push(fileURLToPath(import.meta.resolve('@drsamonline/catalog/seed.json')));
  } catch {
    /* older installs may not export it */
  }
  return candidates;
}

export function loadCatalogue() {
  const seedPath = cataloguePaths().find((candidate) => existsSync(candidate));
  const generatedPath = join(ROOT, 'packages', 'catalog', 'generated.json');
  const entries = [];
  if (seedPath) entries.push(...loadSeed(seedPath));
  if (existsSync(generatedPath)) entries.push(...loadSeed(generatedPath));
  return dedupeEntries(applyVerified(entries, readVerified()));
}

/** Write what a probe observed, atomically, without touching the seed. */
function writeVerified(results) {
  const path = verifiedPath();
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, entries: [] };
  const byProvider = new Map((current.entries ?? []).map((row) => [row.provider, row]));

  for (const result of results) {
    if (!result.ok) {
      // a failure does not erase a previous verification: the endpoint may be
      // down, not wrong. `--revoke` is how a route is withdrawn.
      continue;
    }
    byProvider.set(result.provider, {
      provider: result.provider,
      base_url: result.base_url ?? byProvider.get(result.provider)?.base_url ?? null,
      probe_model: result.probe_model ?? null,
      models: result.models ?? [],
      verified_at: result.checkedAt,
      fixtureVersion: result.fixtureVersion,
      capabilities: result.capabilities ?? ['chat'],
      tos: byProvider.get(result.provider)?.tos ?? 'review',
    });
  }

  const next = { ...current, entries: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)) };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
  return next.entries.length;
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
    if (flags.json) return emitJson('vault', { action: 'list', exists: vault.exists(), providers });
    console.log('');
    console.log(providers.length ? providers.join('\n') : 'The vault is empty.');
    return;
  }

  // status
  if (flags.json) {
    // Names, paths and a boolean gate — never a key, and never the passphrase.
    let providers = null;
    let error = null;
    if (vault.exists()) {
      try {
        providers = await vault.list();
      } catch (err) {
        error = String(/** @type {any} */ (err).message ?? err);
      }
    }
    return emitJson('vault', {
      action: 'status',
      exists: vault.exists(),
      path: vaultPath,
      passphrase: vault.source === 'env' ? 'env' : vault.source === 'keyfile' ? 'keyfile' : 'not found',
      gateOpen: raw.paid_tiers?.enabled === true,
      providers,
      error,
    });
  }

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
  if (!path) throw new ConfigError(`No config found. Run \`${runAs()} init\` first.`);
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

  if (flags.json) {
    emitJson('tokens', {
      ok: failures === 0,
      failures,
      standard: 'WCAG 2.2 AA',
      pairs: report.map(([mode, label, values, ratio, needs, result]) => ({ mode, pair: label, values, ratio: Number(ratio), needs, ok: result === 'pass' })),
    });
    if (failures) process.exitCode = 1;
    return;
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
  if (flags.json) {
    return emitJson('kits', {
      ok: status.every((k) => k.loaded),
      loaded: status.filter((k) => k.loaded).length,
      total: status.length,
      kits: status.map((k) => ({ name: k.name, loaded: Boolean(k.loaded), version: k.version ?? null, error: k.error ?? null })),
    });
  }
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

/* ----------------------------------------------------------------- redteam */

/**
 * `sui redteam [--combo chat-default]` — B6.2: attack your own route.
 *
 * Ten obfuscations of one instruction a well-behaved model must refuse. The
 * canary is random per run, so a model cannot have memorised it.
 */
export async function cmdRedteam(flags, args) {
  const gateway = await createGateway({ configPath: flags.config, ledgerFile: null });
  const combos = Object.keys(gateway.config.combos);
  const combo = args[0] ?? flags.combo ?? combos[0];

  console.log('');
  console.log(`Red-team self-test — ${combo}`);
  console.log(`  ${Object.keys(TRANSFORMS).length} transforms of one injection instruction`);
  console.log('');

  const report = await runSelfTest({
    combo,
    transforms: flags.transform ? [flags.transform] : undefined,
    chat: (input) => gateway.router.chat(input),
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
    return;
  }

  console.log(table(
    ['transform', 'verdict', 'what came back'],
    report.results.map((r) => [r.transform, r.severity, (r.error ?? r.answer ?? '').slice(0, 54)]),
  ));
  console.log('');
  console.log(`  ${report.counts.safe} safe · ${report.counts.high} ambiguous · ${report.counts.critical} obeyed the injection`);
  console.log('');
  console.log(report.pass
    ? '  PASS — no transform got the canary out of this route'
    : '  FAIL — a route that obeys an injected instruction will obey one from a user');
  if (!report.pass) process.exitCode = 1;
}

/* ------------------------------------------------------------------- sandbox */

/**
 * `sui sandbox` — B5.6. Run a snippet in a contained process, or prove the
 * boundary with the attack suite.
 */
export async function cmdSandbox(flags, args) {
  const { runCode, runAttackSuite, sandboxCapabilities } = await import('@drsamonline/sandbox');
  const capabilities = await sandboxCapabilities();

  if (flags['self-test']) {
    console.log('');
    console.log('Attack suite — 14 ways out, and what happened to each');
    console.log('');
    const suite = await runAttackSuite({ runCode, capabilities });
    for (const r of suite.results) {
      console.log(`  ${r.contained ? 'contained' : 'ESCAPED  '} ${r.name.padEnd(40)} ${String(r.ms).padStart(5)}ms  ${r.stderr.slice(0, 44)}`);
    }
    console.log('');
    console.log(`  ${suite.contained} of ${suite.total} contained`);
    console.log(`  permission model: ${capabilities.permissionModel ? 'on' : 'OFF'} · network namespace: ${capabilities.networkIsolated ? 'on' : 'OFF'}`);
    if (!capabilities.fullyIsolated) {
      console.log('  This machine cannot isolate fully. `requireNoNetwork` would refuse to run at all.');
    }
    if (suite.failed) process.exitCode = 1;
    return;
  }

  const file = args[0] ?? flags.file;
  if (!file) {
    console.error('Usage: sui sandbox <file.js> [--wall 5000] [--heap 128]');
    console.error('       sui sandbox --self-test    run the attack suite');
    process.exitCode = 1;
    return;
  }

  const code = readFileSync(file, 'utf8');
  const result = await runCode({
    code,
    capabilities,
    requireNoNetwork: Boolean(flags['require-no-network']),
    limits: {
      ...(flags.wall ? { wallMs: Number(flags.wall) } : {}),
      ...(flags.heap ? { heapMb: Number(flags.heap) } : {}),
    },
  });

  if (result.refused) {
    console.error(result.reason);
    process.exitCode = 1;
    return;
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log('');
  console.log(
    `  exit ${result.exitCode ?? '—'} · ${result.ms}ms · ${result.killed ? 'killed at the wall clock' : 'finished'} · permission model ${result.capabilities.permissionModel ? 'on' : 'off'} · network ${result.capabilities.networkIsolated ? 'isolated' : 'NOT isolated'}`,
  );
  if (!result.ok) process.exitCode = 1;
}

/* --------------------------------------------------------------------- local */

/**
 * `sui local` — B2.6, find a model server on this machine and wire it up.
 *
 * Loopback only, unauthenticated GETs, nothing written unless asked.
 */
export async function cmdLocal(flags) {
  const { discoverLocalRuntimes, toConfigPatch } = await import('@drsamonline/prober');

  const say = flags.json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  say('');
  say('Looking for local model servers on loopback (127.0.0.1)…');

  const found = await discoverLocalRuntimes({ timeoutMs: Number(flags.timeout ?? 300) });

  if (flags.json && (!found.length || !flags.write)) {
    // A scan is a fact about this machine: which servers answered, on which port,
    // with which models. Nothing is written unless --write says so.
    return emitJson('local', {
      ok: found.length > 0,
      scanned: '127.0.0.1',
      runtimes: found.map((r) => ({ kind: r.kind, port: r.port, latencyMs: r.latencyMs, models: r.models })),
      written: false,
    });
  }

  if (!found.length) {
    console.log('');
    console.log('  nothing answered. Servers this looks for, and their default ports:');
    console.log('    Ollama          11434');
    console.log('    LM Studio       1234');
    console.log('    llama.cpp       8080');
    console.log('    vLLM / LocalAI  8000 / 5000');
    console.log('');
    console.log('  Start one and run this again. Nothing was probed outside 127.0.0.1.');
    return;
  }

  console.log('');
  for (const runtime of found) {
    console.log(`  ${runtime.kind} on port ${runtime.port} — ${runtime.models.length} model(s), answered in ${runtime.latencyMs}ms`);
    for (const model of runtime.models.slice(0, 8)) console.log(`    ${model}`);
    if (runtime.models.length > 8) console.log(`    … and ${runtime.models.length - 8} more`);
  }

  if (!flags.write) {
    console.log('');
    console.log('Nothing was written. Run with --write to add these to sui.config.json.');
    return;
  }

  const { applyRecipe } = await import('@drsamonline/core');
  const gateway = await createGateway({ configPath: flags.config });
  const path = flags.config ?? gateway.config.path ?? 'sui.config.json';
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));

  let merged = onDisk;
  let added = 0;
  for (const runtime of found) {
    const recipe = {
      name: 'local-discovery',
      title: `Local ${runtime.kind}`,
      description: 'Discovered on loopback',
      patch: toConfigPatch(runtime),
    };
    const result = applyRecipe(merged, recipe, { force: Boolean(flags.force) });
    merged = result.config;
    added += result.changes.length;
  }

  if (!added) {
    console.log('');
    console.log('  already in the config — nothing to add.');
    return;
  }

  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  if (flags.json) {
    return emitJson('local', { ok: true, scanned: '127.0.0.1', runtimes: found.map((r) => ({ kind: r.kind, port: r.port, latencyMs: r.latencyMs, models: r.models })), written: true, path, changes: added });
  }
  console.log('');
  console.log(`Wrote ${added} change(s) to ${path}. Restart the gateway to pick them up.`);
}

/* ------------------------------------------------------------------- recipes */

/** Where recipes live: the repo's own folder, then the user's config dir. */
/** The same rule the CLI uses: npx only works once the package is published. */
function runAs() {
  const invoked = String(process.argv[1] ?? '');
  if (/node_modules/.test(invoked) || !/apps[\\/]cli[\\/]bin/.test(invoked)) return 'sui';
  return process.platform === 'win32' ? '.\\sui.cmd' : './sui';
}

function recipeDirs() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..', '..');
  return [join(root, 'recipes'), join(homedir(), '.sui', 'recipes')];
}

function loadRecipes() {
  const found = new Map();
  for (const dir of recipeDirs()) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const recipe = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (recipe.name && !found.has(recipe.name)) found.set(recipe.name, recipe);
      } catch {
        /* a broken recipe must not stop the others from loading */
      }
    }
  }
  return found;
}

export async function cmdRecipe(flags, args) {
  const [action = 'list', name] = args;
  const recipes = loadRecipes();

  if (action === 'list') {
    if (flags.json) {
      return emitJson('recipe', {
        action: 'list',
        lookedIn: recipeDirs(),
        recipes: [...recipes.values()].map((r) => ({ name: r.name, title: r.title, description: r.description })),
      });
    }
    if (!recipes.size) {
      console.log('No recipes found. Looked in:', recipeDirs().join(', '));
      return;
    }
    console.log('');
    console.log('Recipes');
    console.log('');
    for (const recipe of recipes.values()) {
      console.log(`  ${recipe.name.padEnd(18)} ${recipe.title}`);
      console.log(`  ${''.padEnd(18)} ${recipe.description}`);
      console.log('');
    }
    console.log(`Apply one: ${runAs()} recipe apply <name> [--dry-run] [--force]`);
    return;
  }

  if (!name) {
    console.error(`Which recipe? Try: ${[...recipes.keys()].join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const recipe = recipes.get(name);
  if (!recipe) {
    console.error(`No recipe called "${name}". Available: ${[...recipes.keys()].join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  if (action === 'show') {
    if (flags.json) return emitJson('recipe', { action: 'show', name: recipe.name, title: recipe.title, description: recipe.description, patch: recipe.patch });
    console.log('');
    console.log(`${recipe.title} (${recipe.name})`);
    console.log('');
    console.log(`  ${recipe.description}`);
    console.log('');
    console.log(JSON.stringify(recipe.patch, null, 2).replace(/^/gm, '  '));
    return;
  }

  if (action !== 'apply') {
    console.error(`Unknown action "${action}". Use list, show or apply.`);
    process.exitCode = 1;
    return;
  }

  const { applyRecipe, describeRecipe } = await import('@drsamonline/core');
  const gateway = await createGateway({ configPath: flags.config });
  const result = applyRecipe(gateway.config, recipe, { force: Boolean(flags.force) });

  if (flags.json) {
    // A dry run and a real run differ in one field, so a script can decide from
    // the document whether anything changed without reading prose.
    let written = false;
    if (result.changes.length && !flags['dry-run']) {
      const path = flags.config ?? gateway.config.path ?? 'sui.config.json';
      const onDisk = JSON.parse(readFileSync(path, 'utf8'));
      const merged = applyRecipe(onDisk, recipe, { force: Boolean(flags.force) }).config;
      writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
      written = true;
    }
    return emitJson('recipe', {
      action: 'apply',
      name: recipe.name,
      dryRun: Boolean(flags['dry-run']),
      written,
      changes: result.changes,
      conflicts: result.conflicts,
      missingEnv: result.missingEnv,
    });
  }

  console.log('');
  console.log(describeRecipe(recipe));
  console.log('');

  if (result.missingEnv.length) {
    console.log(`  needs env: ${result.missingEnv.join(', ')} — set these before the recipe does anything useful`);
    console.log('');
  }
  for (const change of result.changes) console.log(`  + ${change.path}${change.note ? ` (${change.note})` : ''}`);
  for (const conflict of result.conflicts) console.log(`  = ${conflict.path}: ${conflict.reason}`);

  if (!result.changes.length) {
    console.log('  nothing to change — this recipe is already applied.');
    console.log('');
    return;
  }

  if (flags['dry-run']) {
    console.log('');
    console.log('Dry run: nothing was written. Run without --dry-run to apply.');
    return;
  }

  const path = flags.config ?? gateway.config.path ?? 'sui.config.json';
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  // Merge the recipe's additions into the file as it is, so anything the user
  // edited by hand survives.
  const merged = applyRecipe(onDisk, recipe, { force: Boolean(flags.force) }).config;
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  console.log('');
  console.log(`Written to ${path}. Restart the gateway to pick it up.`);
}

/* ---------------------------------------------------------------------- mcp */

/**
 * `sui mcp` — the gateway as a Model Context Protocol server.
 *
 * stdio is what an editor launches; http is what a remote agent can reach. Both
 * serve the same tools, so an agent does not need to know which one you chose.
 */
export async function cmdMcp(flags) {
  const gateway = await createGateway({ configPath: flags.config, ledgerFile: undefined });
  const transport = String(flags.transport ?? 'stdio');
  const server = createMcpServer({ gateway, version: VERSION });

  if (transport === 'http') {
    const port = Number(flags.port ?? 8788);
    const handleMcp = createHttpHandler({ server });

    // Its own listener, not the gateway's: a request handler that has already
    // answered cannot be second-guessed, and MCP deserves its own port anyway.
    const http = await import('node:http');
    const mcpHttp = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const handled = await handleMcp(req, res, url);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `No MCP route for ${req.method} ${url.pathname}. The endpoint is /mcp.` }));
      }
    });

    await new Promise((resolve, reject) => {
      mcpHttp.once('error', reject);
      mcpHttp.listen(port, gateway.config.server.host, resolve);
    });

    console.log('');
    console.log(`sui ${VERSION} — MCP over HTTP`);
    console.log(`  endpoint   http://${gateway.config.server.host}:${port}/mcp`);
    console.log(`  protocol   ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`);
    console.log(`  tools      ${['sui_chat', 'sui_models', 'sui_explain', 'sui_cost', 'sui_compress', 'sui_status'].join(', ')}`);
    console.log('');
    console.log('POST a JSON-RPC message to the endpoint. Ctrl-C to stop.');

    await new Promise((resolve) => {
      const stop = () => {
        mcpHttp.closeAllConnections?.();
        mcpHttp.close(() => resolve(undefined));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }

  // stdout is the protocol. The banner goes to stderr, or the client sees a
  // non-JSON line and drops the connection.
  console.error(`sui ${VERSION} — MCP over stdio (protocol ${SUPPORTED_PROTOCOL_VERSIONS[0]}). Logs go to stderr.`);
  await runStdio({ server });
}

/* ------------------------------------------------------------------ tenants */

/** `sui tenants` — B7.7: what each key has spent, and what it may reach. */
export async function cmdTenants(flags) {
  const gateway = await createGateway({ configPath: flags.config, ledgerFile: undefined });
  const { config, ledger } = gateway;

  const { tenantSnapshot, tenantSummary } = await import('@drsamonline/core');
  const snapshot = tenantSnapshot({ config, ledger });
  const summary = tenantSummary(snapshot);
  const configured = (config.apiKeys ?? []).length > 0;

  // --json means stdout is the document. A helpful sentence there breaks a pipe,
  // and an empty result is still a result: it says zero tenants are configured.
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          summary,
          tenants: snapshot,
          ...(configured ? {} : { note: 'No API keys are configured, so every caller is the same anonymous tenant.' }),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!configured) {
    console.log('');
    console.log('No API keys are configured, so every caller is the same anonymous tenant.');
    console.log('Add an apiKeys entry to sui.config.json to separate them.');
    return;
  }

  console.log('');
  console.log(`Tenants — ${summary.tenants} key(s), ${summary.capped} capped, ${summary.uncapped} uncapped`);
  console.log('');
  console.log(
    table(
      ['tenant', 'turns', 'failed', 'spent', 'cap', 'used', 'rpm', 'reaches'],
      snapshot.map((t) => [
        t.name,
        String(t.turns),
        String(t.failed),
        `$${t.spentUsd.toFixed(4)}`,
        t.dailyUsd == null ? 'uncapped' : `$${t.dailyUsd.toFixed(2)}`,
        t.pct == null ? '—' : `${t.pct}%`,
        t.rateLimit?.rpm ? String(t.rateLimit.rpm) : '—',
        t.allowedCombos ? t.allowedCombos.join(',') : 'everything',
      ]),
    ),
  );
  if (summary.nearestCap) {
    console.log('');
    console.log(`  closest to its cap: ${summary.nearestCap}`);
  }
  console.log('');
  console.log('Change a cap live: curl -X PATCH /api/tenants/<name> -d \'{"dailyUsd":5}\'');
}

/* ------------------------------------------------------------------ explain */

/** `sui explain [combo]` — B7.4, why a route would go where it goes. */
export async function cmdExplain(flags, args) {
  const gateway = await createGateway({ configPath: flags.config, ledgerFile: null });
  const combos = Object.keys(gateway.config.combos);
  const combo = args[0] ?? flags.combo ?? combos[0];
  if (!gateway.config.combos[combo]) {
    throw new ConfigError(`No combo called "${combo}". Available: ${combos.join(', ')}.`);
  }

  const plan = gateway.router.plan(combo, {});
  const lines = explainPlan(plan);

  if (flags.json) {
    console.log(JSON.stringify({ combo, lines, plan: { ordered: plan.ordered.map((t) => t.modelId), resting: plan.resting.map((t) => t.modelId), skipped: plan.skipped } }, null, 2));
    return;
  }

  console.log('');
  console.log(`Explain-my-route — ${combo}`);
  console.log('');
  for (const line of lines) console.log(`  ${line}`);
  console.log('');
  console.log('Nothing was sent. This is the plan, computed from the config and the ledger.');
}

/* ------------------------------------------------------------------ savings */

/** `sui savings` — B7.2: what cache hits and compression did not spend. */
export async function cmdSavings(flags) {
  const gateway = await createGateway({ configPath: flags.config, ledgerFile: undefined });
  const { ledger } = gateway;
  const since = flags.all ? 0 : startOfToday();
  const agg = ledger.aggregate({ since });
  const s = agg.totals.savings;

  if (flags.json) {
    console.log(JSON.stringify({ since: agg.since, savings: s, spentUsd: agg.totals.costUsd, turns: agg.totals.turns }, null, 2));
    return;
  }

  const wouldHaveCost = agg.totals.costUsd + s.totalUsd;
  console.log('');
  console.log('Savings ledger');
  console.log('');
  console.log(table(
    ['what', 'value'],
    [
      ['spent', `$${agg.totals.costUsd.toFixed(4)}`],
      ['saved by cache', `$${s.cacheUsd.toFixed(4)} (${s.cacheHits} hit${s.cacheHits === 1 ? '' : 's'})`],
      ['saved by compression', `$${s.compressionUsd.toFixed(4)} (${s.compressedTurns} turn${s.compressedTurns === 1 ? '' : 's'})`],
      ['total saved', `$${s.totalUsd.toFixed(4)}`],
      ['tokens not sent', s.tokensSaved.toLocaleString('en-IN')],
      ['would have cost', `$${wouldHaveCost.toFixed(4)}`],
      ['share avoided', wouldHaveCost ? `${Math.round((s.totalUsd / wouldHaveCost) * 100)}%` : '—'],
    ],
  ));
  console.log('');
  console.log(flags.all ? 'All time.' : 'Today. Use --all for everything in the ledger.');
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ----------------------------------------------------------------- compress */

/**
 * `sui compress <file> [--preset ultra]` — see exactly what a preset would do to
 * a prompt before you turn compression on for real traffic.
 */
export function cmdCompress(flags, args) {
  const preset = String(flags.preset ?? 'standard');
  if (!PRESETS[preset]) throw new ConfigError(`Unknown preset "${preset}". Use: ${Object.keys(PRESETS).join(', ')}.`);

  let text;
  if (typeof flags.text === 'string') text = flags.text;
  else if (args[0] && args[0] !== '-') {
    const path = args[0];
    if (!existsSync(path)) throw new ConfigError(`No file at ${path}.`);
    text = readFileSync(path, 'utf8');
  } else {
    text = readFileSync(0, 'utf8'); // stdin
  }

  if (!text.trim()) throw new ConfigError('Nothing to compress. Pass a file, --text "…", or pipe something in.');

  const store = new RecallStore({ secret: process.env.SUI_RECALL_SECRET ?? 'sui-cli' });
  const result = compress(text, { preset, store });

  if (flags.json) {
    console.log(JSON.stringify({ ...result, text: undefined, textChars: result.text.length }, null, 2));
    return;
  }

  console.log('');
  console.log(`preset ${preset} — ${result.originalChars} → ${result.compressedChars} chars (${Math.round(result.ratio * 100)}% smaller)`);
  console.log('');
  if (result.skipped) {
    console.log(`  nothing to do: ${result.skipped}`);
    return;
  }
  console.log(table(['engine', 'what it did', 'chars'], result.steps.map((s) => [s.engine, s.note, String(s.droppedChars)])));

  if (result.tokens.length) {
    console.log('');
    console.log(`recall tokens: ${result.tokens.join(', ')} (the dropped text is in memory for this process only)`);
  }

  if (flags.out) {
    writeFileSync(String(flags.out), result.text);
    console.log('');
    console.log(`written: ${flags.out}`);
    return;
  }
  console.log('');
  console.log('--- compressed prompt ---');
  console.log(result.text);
}

/** `sui budget` — what preset the quota would pick right now. */
export function cmdBudget(flags) {
  const fraction = Number(flags.fraction ?? 1);
  const chosen = choosePreset({ fraction });
  if (flags.json) {
    return emitJson('budget', {
      fraction,
      chosen: { preset: chosen.preset, reason: chosen.reason },
      presets: Object.fromEntries(Object.entries(PRESETS).map(([name, p]) => [name, { target: p.target, floor: p.floor, engines: p.engines }])),
    });
  }
  console.log('');
  console.log(`quota fraction ${fraction} → preset ${chosen.preset}`);
  console.log(`  ${chosen.reason}`);
  console.log('');
  console.log(table(['preset', 'target', 'floor', 'engines'], Object.entries(PRESETS).map(([name, p]) => [name, `${Math.round(p.target * 100)}%`, `${Math.round(p.floor * 100)}%`, p.engines.join(' → ')])));
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

  // In --json mode stdout is the document: a preamble on stdout makes the output
  // unparseable, which is how a CI step discovers it before a user does.
  // A sweep is bounded, not serial: `--concurrency 1` is the old one-at-a-time
  // behaviour, and the default keeps enough in flight to finish in seconds while
  // staying under the burst a free tier will answer without a 429.
  // `--concurrency -1` reaches the parser as a bare flag (the value starts with
  // "-"), which would quietly become 1 and then a whole sweep would run one at a
  // time. A flag that takes a number must refuse to be a boolean.
  if (flags.concurrency === true) {
    throw new ConfigError('--concurrency needs a number, e.g. --concurrency 8 (or --concurrency=4 for a negative-looking value).');
  }
  const concurrency = flags.concurrency == null ? DEFAULT_PROBE_CONCURRENCY : Number(flags.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ConfigError(`--concurrency must be a whole number of at least 1, not "${flags.concurrency}".`);
  }

  const say = flags.json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  say('');
  say(`Probing ${probeable.length} of ${selected.length} entries (fixtures v${PROBE_FIXTURE_VERSION}, ${concurrency} at a time)`);
  if (identities.length) {
    say(`${identities.length} have no base_url yet — an identity is not an endpoint, so they are not probed.`);
  }
  say('');

  // Naming a provider is intent: `sui probe ollama` means "probe the model server
  // on this machine". A full sweep is not — there the guard refuses loopback,
  // link-local and private addresses, because a catalogue entry is data and data
  // can name anything, including cloud metadata.
  const prober = new Prober({
    entries: probeable,
    timeoutMs: Number(flags.timeout ?? 8000),
    concurrency,
    allowLocal: args.length > 0,
  });
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
  console.log(`${ok} of ${results.length} probed entries answered.`);

  if (flags.revoke) {
    const provider = args[0] ?? flags.provider;
    const path = verifiedPath();
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, entries: [] };
    const before = (current.entries ?? []).length;
    current.entries = (current.entries ?? []).filter((row) => row.provider !== provider);
    writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Revoked ${before - current.entries.length} verification(s) for ${provider}.`);
    return;
  }

  if (flags.write) {
    if (!ok) {
      console.log('Nothing to write: no entry answered, so no route was promoted.');
      return;
    }
    const total = writeVerified(results.map((r) => ({ ...r, base_url: probeable.find((e) => e.provider === r.provider)?.base_url })));
    console.log(`Wrote ${ok} verification(s) to ${verifiedPath()} (${total} on record).`);
    console.log('Those entries are now routable. `sui catalog` shows them as verified.');
    return;
  }

  if (!ok) {
    console.log('Nothing is routable yet. That is the honest state, not a bug: a route becomes verified by answering.');
  } else {
    console.log('Run `sui probe --write` to promote what answered into the catalogue.');
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
