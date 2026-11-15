/**
 * The `sui` command line.
 *
 *   sui                     first run: find keys, find tools, prove the route, start
 *   sui init                the same, explicitly
 *   sui up                  run the gateway
 *   sui doctor              one real turn per combo, and say what broke
 *   sui models              what this gateway will answer to
 *   sui cost                what it has spent, and on what
 *   sui tools               point a coding tool at the gateway
 *   sui migrate <file>      import providers/aliases from another router
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, loadEnvFile } from '@sui/gateway';
import { auditConfig, defaultConfigPath, hashApiKey, normalizeConfig, providerHasCredentials, sanitizeConfig, suiHome, INVARIANTS } from '@sui/core';
import { runInit } from './onboarding.js';
import { detectTools, writeToolConfig } from './tools.js';
import { applyImport, diffImport, readMigrationSource, smokeTest } from './migrate.js';
import { cmdBudget, cmdCatalog, cmdCompress, cmdConfig, cmdExplain, cmdKits, cmdLocal, cmdMcp, cmdProbe, cmdRecipe, cmdRedteam, cmdSavings, cmdTenants, cmdTokens, cmdVault, writeExport } from './commands-extra.js';
import { kitStatus } from '@sui/kits';
import { ConfigError } from '@sui/core';

// One source of truth for the version: the package manifest.
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE_DIR, '..', '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0-unknown';
  }
})();

export async function run(argv = process.argv.slice(2)) {
  const { command, args, flags } = parse(argv);

  switch (command) {
    case undefined:
    case 'init':
      return cmdInit(flags);
    case 'up':
    case 'start':
    case 'serve':
      return cmdUp(flags);
    case 'keys':
      return cmdKeys(flags, args);
    case 'catalog':
      return cmdCatalog(flags, args);
    case 'probe':
      return cmdProbe(flags, args);
    case 'compress':
      return cmdCompress(flags, args);
    case 'budget':
      return cmdBudget(flags);
    case 'savings':
      return cmdSavings(flags);
    case 'explain':
      return cmdExplain(flags, args);
    case 'tenants':
      return cmdTenants(flags);
    case 'mcp':
      return cmdMcp(flags);
    case 'recipe':
      return cmdRecipe(flags, args);
    case 'local':
      return cmdLocal(flags);
    case 'redteam':
      return cmdRedteam(flags, args);
    case 'vault':
      return cmdVault(flags, args);
    case 'config':
      return cmdConfig(flags, args);
    case 'tokens':
      return cmdTokens(flags);
    case 'kits':
      return cmdKits(flags);
    case 'invariants':
      return cmdInvariants(flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'models':
      return cmdModels(flags);
    case 'cost':
    case 'usage':
      return cmdCost(flags);
    case 'tools':
      return cmdTools(flags, args);
    case 'migrate':
      return cmdMigrate(flags, args);
    case 'help':
    case '--help':
    case '-h':
      return help();
    case 'version':
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      console.error(`Unknown command "${command}". Try: sui help`);
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ commands */

async function cmdInit(flags) {
  const interactive = Boolean(stdin.isTTY) && !flags.yes;
  const prompt = interactive ? makePrompt() : null;
  try {
    const result = await runInit({
      cwd: process.cwd(),
      env: loadEnvFile(process.env.SUI_ENV_FILE ?? '.env', { ...process.env }),
      interactive,
      force: Boolean(flags.force),
      demo: Boolean(flags.demo),
      port: flags.port ? Number(flags.port) : undefined,
      prompt,
    });
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    if (flags['no-serve'] || !interactive) {
      console.log('');
      console.log('Start it with: npx sui start');
      return;
    }
    const answer = await prompt.ask('Start the gateway now? (Y/n)', 'y');
    if (/^y/i.test(answer) || answer === '') return cmdUp({ ...flags, config: result.configPath });
    console.log('Fine — run `npx sui start` when you want it.');
  } finally {
    prompt?.close();
  }
}

async function cmdUp(flags) {
  // `sui start` is the one place background jobs run.
  const gateway = await createGateway({ configPath: flags.config, startWorkers: flags['no-workers'] !== true });
  const { config, server } = gateway;
  const host = config.server.host;
  const port = flags.port ? Number(flags.port) : config.server.port;

  try {
    await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(port, host, res);
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e.code === 'EADDRINUSE') {
      throw new ConfigError(
        `Port ${port} is already in use. Either stop what is on it, or start sui elsewhere: npx sui start --port ${port + 1}`,
        { detail: e.message, path: 'server.port' },
      );
    }
    if (e.code === 'EACCES') {
      throw new ConfigError(`Not allowed to bind ${host}:${port}. Ports below 1024 need elevated privileges — use a higher port and put a proxy in front.`, {
        detail: e.message,
        path: 'server.port',
      });
    }
    throw err;
  }

  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  const combos = Object.keys(config.combos);
  console.log('');
  console.log(`sui ${VERSION} is up`);
  console.log(`  endpoint   http://${shown}:${port}/v1`);
  console.log(`  dashboard  http://${shown}:${port}/`);
  console.log(`  config     ${config.path ?? '(none)'}`);
  console.log(`  combos     ${combos.join(', ')}`);
  console.log(`  paid tier  ${config.paidTiers?.enabled ? 'ENABLED — paid credentials will load' : 'closed (paid credentials are never read)'}`);
  const unconfigured = Object.entries(config.models)
    .filter(([, m]) => !providerHasCredentials(config.providers[/** @type {any} */ (m).provider], config.env))
    .map(([id]) => id);
  if (unconfigured.length) console.log(`  no key yet ${unconfigured.join(', ')}`);
  console.log('');
  const jobs = gateway.workers.snapshot();
  if (jobs.enabled && jobs.jobs.length) {
    console.log(`  workers    ${jobs.jobs.map((j) => `${j.name} every ${Math.round(j.intervalMs / 1000)}s`).join(', ')}`);
  } else {
    console.log('  workers    off (pass --no-workers to keep them off, or set workers.enabled:false)');
  }
  console.log('Ctrl-C to stop.');

  const shutdown = () => {
    console.log('\nstopping…');
    gateway.workers.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdDoctor(flags) {
  const gateway = await createGateway({ configPath: flags.config, ledgerFile: null });
  const { config, router } = gateway;
  const combos = flags.combo ? [String(flags.combo)] : Object.keys(config.combos);

  console.log('');
  console.log('sui doctor — one real turn per combo');
  console.log('');

  const rows = [];
  let anyOk = false;
  for (const combo of combos) {
    const started = Date.now();
    try {
      const res = await router.chat({
        combo,
        body: { messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 16 },
      });
      anyOk = true;
      rows.push([
        combo,
        'ok',
        res.meta.modelId,
        res.meta.provider,
        `${res.meta.latencyMs} ms`,
        `${res.usage.prompt_tokens}+${res.usage.completion_tokens} tok`,
        `$${res.meta.costUsd.toFixed(6)}`,
      ]);
    } catch (err) {
      const message = /** @type {any} */ (err).message ?? String(err);
      rows.push([combo, 'failed', '—', '—', `${Date.now() - started} ms`, '—', message.slice(0, 80)]);
    }
  }

  console.log(table(['combo', 'result', 'answered by', 'provider', 'latency', 'tokens', 'cost'], rows));

  const healthy = Object.entries(config.models).filter(([, m]) =>
    providerHasCredentials(config.providers[/** @type {any} */ (m).provider], config.env),
  ).length;
  console.log('');
  console.log(`${healthy} of ${Object.keys(config.models).length} models have credentials.`);

  const kits = kitStatus();
  const kitsBroken = kits.filter((k) => !k.loaded);
  console.log('');
  console.log(`Vendored kits: ${kits.length - kitsBroken.length}/${kits.length} loaded${kitsBroken.length ? ` — broken: ${kitsBroken.map((k) => k.name).join(', ')}` : ''}`);
  console.log(`Paid vault:    ${config.vault?.reason ?? 'not opened'}`);

  const audit = auditConfig(config);
  const failing = audit.filter((a) => !a.ok);
  console.log('');
  console.log('Invariants that can be checked without sending a request');
  for (const a of audit) console.log(`  ${a.ok ? 'ok  ' : 'WARN'}  ${a.id}  ${a.detail}`);
  if (failing.length) console.log(`\n${failing.length} invariant warning(s) — see docs/ARCHITECTURE.md and \`npx sui invariants\`.`);
  if (!anyOk) {
    console.log('No combo answered. That is the thing to fix before anything else.');
    process.exitCode = 1;
  }
}

async function cmdModels(flags) {
  const gateway = await createGateway({ configPath: flags.config, ledgerFile: null });
  const { config } = gateway;
  if (flags.json) {
    console.log(JSON.stringify(sanitizeConfig(config), null, 2));
    return;
  }
  console.log('');
  console.log('Combos — the names your tools call');
  console.log('');
  const comboRows = Object.entries(config.combos).map(([id, c]) => {
    const combo = /** @type {any} */ (c);
    const targets = combo.targets.map((t) => (typeof t === 'string' ? t : `${t.model} (${t.weight})`));
    return [id, combo.strategy, combo.label ?? '', targets.join(' → ')];
  });
  console.log(table(['combo', 'strategy', 'what it is', 'order'], comboRows));

  console.log('');
  console.log('Models — what a combo can reach');
  console.log('');
  const modelRows = Object.entries(config.models).map(([id, m]) => {
    const model = /** @type {any} */ (m);
    const ready = providerHasCredentials(config.providers[model.provider], config.env);
    const cost = model.costPer1kIn != null ? `$${model.costPer1kIn}/$${model.costPer1kOut} per 1k` : 'not priced';
    return [id, model.provider, model.model, ready ? 'ready' : `needs ${config.providers[model.provider]?.apiKeyEnv ?? 'credentials'}`, cost];
  });
  console.log(table(['model', 'provider', 'upstream name', 'status', 'cost in/out'], modelRows));
}

async function cmdCost(flags) {
  const gateway = await createGateway({ configPath: flags.config });
  const { ledger, config } = gateway;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const agg = ledger.aggregate({ since: flags.all ? 0 : today.getTime() });

  // B7.1: charge-back view — who asked, and with what
  if (flags.by === 'user' || flags.by === 'tool') {
    const groups = flags.by === 'user' ? agg.byUser : agg.byTool;
    console.log('');
    console.log(`Cost by ${flags.by}`);
    console.log('');
    console.log(
      table(
        [flags.by, 'turns', 'failed', 'cost'],
        Object.entries(groups)
          .sort((a, b) => b[1].costUsd - a[1].costUsd)
          .map(([name, g]) => [name, String(g.turns), String(g.failed), `$${g.costUsd.toFixed(4)}`]),
      ),
    );
    console.log('');
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify(agg, null, 2));
    return;
  }

  const daily = config.budgets.dailyUsd;
  const spent = ledger.todaySpendUsd();
  console.log('');
  console.log(`Spend today   $${spent.toFixed(4)}${daily ? ` of $${Number(daily).toFixed(2)} (${Math.min(100, Math.round((spent / Number(daily)) * 100))}%)` : ''}`);
  if (daily) console.log(`Budget        ${bar(spent / Number(daily), 32)}`);
  console.log(`Turns         ${agg.totals.turns} (${agg.totals.ok} ok, ${agg.totals.failed} failed, ${agg.totals.cached} cached)`);
  console.log(`Tokens        ${agg.totals.promptTokens} in / ${agg.totals.completionTokens} out`);
  console.log(`Latency       p50 ${agg.totals.p50LatencyMs} ms · p95 ${agg.totals.p95LatencyMs} ms · first token ${agg.totals.avgTtftMs} ms`);
  console.log('');

  const providerRows = Object.entries(agg.byProvider).map(([id, v]) => [
    id, String(/** @type {any} */ (v).turns), `$${/** @type {any} */ (v).costUsd.toFixed(4)}`, `${/** @type {any} */ (v).avgLatencyMs} ms`,
  ]);
  if (providerRows.length) console.log(table(['provider', 'turns', 'cost', 'avg latency'], providerRows));

  const armRows = Object.entries(agg.byArm).map(([id, v]) => [
    id, String(/** @type {any} */ (v).turns), `$${/** @type {any} */ (v).costUsd.toFixed(4)}`, `${/** @type {any} */ (v).avgLatencyMs} ms`,
  ]);
  if (armRows.length) {
    console.log('');
    console.log('A/B arms');
    console.log(table(['combo/arm', 'turns', 'cost', 'avg latency'], armRows));
  }
  if (flags.export || flags.gzip) {
    await writeExport({
      ledger,
      file: typeof flags.export === 'string' ? flags.export : undefined,
      format: flags.json ? 'json' : 'csv',
      gzip: Boolean(flags.gzip),
    });
  } else {
    console.log('');
    console.log('Export: npx sui cost --export usage.csv [--gzip]   (or the dashboard\'s Export CSV)');
  }
}

async function cmdTools(flags, args) {
  const tools = detectTools({ env: loadEnvFile('.env', { ...process.env }) });
  const want = flags.set ?? args[0];

  if (want) {
    const configPath = defaultConfigPath();
    const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
    if (!config) throw new ConfigError('No config yet. Run `npx sui init` first.');
    const combo = flags.combo ?? Object.keys(config.combos ?? {})[0];
    const port = config.server?.port ?? 8787;
    const result = writeToolConfig(want, {
      baseUrl: `http://${config.server?.host === '0.0.0.0' ? '127.0.0.1' : config.server?.host ?? '127.0.0.1'}:${port}`,
      combo,
      apiKey: config.apiKeys?.[0]?.key ?? 'sui-local',
      dryRun: Boolean(flags['dry-run']),
    });
    console.log(result.message);
    if (result.snippet) console.log(result.snippet);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('Coding tools on this machine');
  console.log('');
  console.log(
    table(
      ['tool', 'status', 'setup', 'where'],
      tools.map((t) => [
        t.name,
        t.detected ? 'found' : 'not found',
        t.setup === 'file' ? 'I can write it' : 'paste 2 fields',
        t.detected ? t.configPath ?? t.evidence ?? '—' : '—',
      ]),
    ),
  );
  console.log('');
  console.log('Point one at the gateway:  npx sui tools --set continue');
  console.log('Available ids: ' + tools.map((t) => t.id).join(', '));
}

async function cmdMigrate(flags, args) {
  const file = args[0] ?? flags.from;
  if (!file) {
    throw new ConfigError('Say which config to import: npx sui migrate ./9router.json');
  }
  const imported = readMigrationSource(resolve(file));
  const configPath = flags.config ?? defaultConfigPath();
  if (!configPath) throw new ConfigError('No sui config yet. Run `npx sui init` first.');
  const currentRaw = JSON.parse(readFileSync(configPath, 'utf8'));
  const gateway = await createGateway({ configPath, ledgerFile: null });
  const diff = diffImport(gateway.config, imported);

  console.log('');
  console.log(`Reading ${file} — looks like ${imported.source}`);
  console.log('');
  console.log(`Found  ${Object.keys(imported.providers).length} providers · ${Object.keys(imported.models).length} models · ${Object.keys(imported.combos).length} combos`);
  console.log('');
  console.log('New to your config');
  console.log(`  providers  ${diff.added.providers.join(', ') || '—'}`);
  console.log(`  models     ${diff.added.models.join(', ') || '—'}`);
  console.log(`  combos     ${diff.added.combos.join(', ') || '—'}`);
  if (diff.conflicts.length) {
    console.log('');
    console.log('Skipped (already exist here)');
    for (const c of diff.conflicts) console.log(`  ${c.kind} ${c.id} — ${c.reason}`);
  }
  if (diff.dangling.length) {
    console.log('');
    console.log(`Models whose provider is not coming along: ${diff.dangling.join(', ')}`);
  }
  if (diff.danglingCombos.length) {
    console.log(`Combos pointing at models that are not coming along: ${diff.danglingCombos.join(', ')}`);
  }
  if (imported.warnings.length) {
    console.log('');
    console.log('Notes');
    for (const w of imported.warnings) console.log(`  - ${w}`);
  }
  if (imported.unknownKeys.length) {
    console.log('');
    console.log(`Keys I did not recognise (left untouched): ${imported.unknownKeys.join(', ')}`);
  }

  if (!flags.apply) {
    console.log('');
    console.log(`Nothing written. Re-run with --apply to import ${diff.total} entr${diff.total === 1 ? 'y' : 'ies'}.`);
    return;
  }

  const select = flags.only
    ? {
        providers: diff.added.providers.filter((id) => String(flags.only).split(',').includes(id)),
        models: diff.added.models.filter((id) => String(flags.only).split(',').includes(id)),
        combos: diff.added.combos.filter((id) => String(flags.only).split(',').includes(id)),
      }
    : {};
  const next = applyImport(currentRaw, imported, select);
  const backup = `${configPath}.bak-${Date.now()}`;
  copyFileSync(configPath, backup);
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  console.log('');
  console.log(`Imported into ${configPath} (previous version kept as ${backup}).`);

  const importedCombos = (select.combos?.length ? select.combos : diff.added.combos).filter((c) => next.combos[c]);
  if (!importedCombos.length) {
    console.log('No new combos to smoke-test.');
    return;
  }
  console.log('');
  console.log('Smoke test — one small turn per imported combo');
  const fresh = await createGateway({ configPath, ledgerFile: null });
  const results = await smokeTest(fresh.router, importedCombos);
  console.log(
    table(
      ['combo', 'result', 'provider', 'note'],
      results.map((r) => [r.combo, r.status, r.provider ?? '—', r.note ?? `${r.ms} ms`]),
    ),
  );
  if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
}

/**
 * `sui keys hash` — replace plaintext API keys in the config with SHA-256
 * hashes, so a leaked config file is not a leaked key (I15).
 */
async function cmdKeys(flags, args) {
  const sub = args[0] ?? (flags.hash ? 'hash' : null);
  if (sub !== 'hash') {
    console.log('');
    console.log('Usage: npx sui keys hash [--config <file>]');
    console.log('');
    console.log('Rewrites every plaintext key in apiKeys as a SHA-256 hash. The keys');
    console.log('themselves still work — they are simply no longer stored in the file.');
    return;
  }
  const path = flags.config ?? defaultConfigPath();
  if (!path) throw new ConfigError('No config found. Run `npx sui init` first.');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const keys = Array.isArray(raw.apiKeys) ? raw.apiKeys : [];
  let changed = 0;
  for (const k of keys) {
    if (k.key && !k.key_hash) {
      k.key_hash = hashApiKey(k.key);
      delete k.key;
      changed += 1;
    }
  }
  if (!changed) {
    console.log('Nothing to do: every configured key is already hashed, or there are none.');
    return;
  }
  copyFileSync(path, `${path}.bak-${Date.now()}`);
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  console.log(`Hashed ${changed} key(s) in ${path}. Previous version kept as a .bak file.`);
  console.log('Restart the gateway to pick it up.');
}

function cmdInvariants(flags) {
  const gatewayConfig = flags.config ? createGatewayConfig(flags.config) : createGatewayConfig();
  const audit = auditConfig(gatewayConfig);
  console.log('');
  console.log('Invariants');
  console.log('');
  console.log(table(['id', 'status', 'statement'], INVARIANTS.map((i) => [i.id, i.status, i.statement])));
  console.log('');
  console.log('Checked now');
  for (const a of audit) console.log(`  ${a.ok ? 'ok  ' : 'WARN'}  ${a.id}  ${a.detail}`);
  console.log('');
  const gaps = INVARIANTS.filter((i) => i.gap);
  if (gaps.length) {
    console.log('Known gaps');
    for (const g of gaps) console.log(`  ${g.id}  ${g.gap}`);
    console.log('');
  }
}

function createGatewayConfig(path) {
  const resolved = path ?? defaultConfigPath();
  if (!resolved) throw new ConfigError('No config found. Run `npx sui init` first.');
  return normalizeConfig(JSON.parse(readFileSync(resolved, 'utf8')), { path: resolved, env: loadEnvFile('.env', { ...process.env }) });
}

function help() {
  console.log(`
sui ${VERSION} — one endpoint for every LLM

  npx sui                 first run: find keys, find tools, prove the route, start
  npx sui init            the same, explicitly      --demo  --force  --port 8787
  npx sui start           run the gateway            --port 8787  --config <file>  --no-workers
                          (aliases: up, serve)
  npx sui invariants      every hard constraint, and which are enforced
  npx sui keys hash       replace plaintext API keys with SHA-256 hashes
  npx sui doctor          one real turn per combo, and say what broke
  npx sui models          the combos and what they can reach   --json
  npx sui cost            spend, latency and A/B arms           --json  --all   (alias: usage)
                          --by user|tool for charge-back attribution
  npx sui tools           point a coding tool here              --set <tool-id>
  npx sui migrate <file>  import from 9router / OmniRoute / HubGate   --apply  --only a,b
  npx sui catalog [q]    the provider catalogue, and what is still unverified
  npx sui probe [name]   liveness, readiness and suitability checks (B2.3)
  npx sui compress <file|-> [--preset lite|standard|aggressive|ultra] [--text "…"]
  npx sui budget         which preset the remaining quota would choose
  npx sui savings        what cache hits and compression did not spend   --all
  npx sui explain [combo] why a route would go where it goes (B7.4)
  npx sui tenants        what each API key has spent, and what it may reach
  npx sui mcp            serve the gateway over MCP   --transport stdio|http  --port 8788
  npx sui recipe list    named config patches: list, show, apply  --dry-run  --force
  npx sui local          find a model server on this machine   --write  --timeout 300
  npx sui redteam [combo] attack your own route with 10 obfuscations (B6.2)
  npx sui vault <cmd>    init | set <provider> | list | remove <provider> | status
  npx sui config <cmd>   show | get <path> | set <path> <value> | unset <path>
  npx sui tokens --check WCAG AA on the dashboard tokens, computed by tokens-kit
  npx sui kits           the vendored kits and whether they load

Endpoint, once running:   http://127.0.0.1:8787/v1
Dashboard:                http://127.0.0.1:8787/
Docs:                     docs/ARCHITECTURE.md, docs/ROUTING.md, docs/MIGRATION.md
`);
}

/* ------------------------------------------------------------------- helpers */

/** Flags that take a value, so `--config ./x.json` works as well as `--config=./x.json`. */
const VALUE_FLAGS = new Set(['config', 'port', 'set', 'only', 'from', 'combo', 'env', 'export', 'provider', 'key', 'q', 'preset', 'text', 'out', 'fraction', 'timeout', 'by', 'transport']);

function parse(argv) {
  const args = [];
  const flags = {};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) {
        flags[k] = inline;
      } else if (VALUE_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[k] = argv[++i];
      } else {
        flags[k] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = true;
    } else if (!command && !/^\d+$/.test(a)) {
      command = a;
    } else {
      args.push(a);
    }
  }
  return { command, args, flags };
}

function makePrompt() {
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    ask: (q, dflt = '') => rl.question(`${q}${dflt ? ` [${dflt}]` : ''} `).then((a) => (a.trim() || dflt)),
    async choose(q, options) {
      console.log('');
      console.log(q);
      options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
      const answer = await rl.question(`Pick 1-${options.length} [${options.length}] `);
      const idx = Number(answer.trim() || options.length) - 1;
      return options[Math.min(Math.max(idx, 0), options.length - 1)];
    },
    close: () => rl.close(),
  };
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), '  ' + widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function bar(ratio, width) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

export { table, bar };
