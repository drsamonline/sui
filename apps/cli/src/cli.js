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
import { createGateway, loadEnvFile } from '@drsamonline/gateway';
import { auditConfig, defaultConfigPath, hashApiKey, normalizeConfig, providerHasCredentials, runAs, sanitizeConfig, suiHome, t, availableLocales, INVARIANTS, sanitiseKey } from '@drsamonline/core';
import { runInit } from './onboarding.js';
import { detectTools, writeToolConfig } from './tools.js';
import { applyImport, diffImport, readMigrationSource, smokeTest } from './migrate.js';
import { cmdBudget, cmdCatalog, cmdCompress, cmdConfig, cmdExplain, cmdFreeBudget, cmdKits, cmdLocal, cmdMcp, cmdProbe, cmdRecipe, cmdRedteam, cmdSandbox, cmdSavings, cmdTenants, cmdTokens, cmdVault, loadCatalogue, writeExport } from './commands-extra.js';
import { kitStatus } from '@drsamonline/kits';
import { ConfigError } from '@drsamonline/core';

// One source of truth for the version: the package manifest.
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
/**
 * How should the user run the next command?
 *
 * `npx sui` only works once the package is on npm, which it is not. Printing it
 * anyway sends people to a command that fails — and the failure looks like a
 * broken install rather than an unpublished package.
 */
// One definition, in core, so the CLI and the errors it throws cannot disagree
// about what to type next.
const RUN_AS = runAs();

const VERSION = (() => {
  // The CLI's own manifest, not the repository root: from a registry install there
  // is no repository root, and walking up to one printed 0.0.0-unknown on a
  // package that was published correctly.
  for (const candidate of [join(HERE_DIR, '..', 'package.json'), join(HERE_DIR, '..', '..', '..', 'package.json')]) {
    try {
      const version = JSON.parse(readFileSync(candidate, 'utf8')).version;
      if (version) return version;
    } catch {
      /* try the next one */
    }
  }
  return '0.0.0-unknown';
})();

export async function run(argv = process.argv.slice(2)) {
  const { command, args, flags } = parse(argv);

  // `sui --version` and `sui --help` are the two things anyone types first, and
  // both arrive as flags rather than as a command. Answer them before dispatch.
  if (!command && (flags.version === true || flags.v === true)) return console.log(VERSION);
  if (!command && (flags.help === true || flags.h === true)) return help();

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
    case 'lang':
    case 'languages': {
      const rows = availableLocales().map((l) => [l.code, l.name, l.dir]);
      if (flags.json) {
        console.log(JSON.stringify(availableLocales(), null, 2));
        return;
      }
      console.log('');
      console.log(table(['code', 'language', 'direction'], rows));
      console.log('');
      console.log('  Set one with SUI_LANG=hi (or "locale": "hi" in the config).');
      console.log('  Anything not listed falls back to English rather than failing.');
      console.log('');
      return;
    }
    case 'free-budget':
      return cmdFreeBudget(flags);
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
    case 'sandbox':
      return cmdSandbox(flags, args);
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
      console.log(`Start it with: ${RUN_AS} start`);
      return;
    }
    const answer = await prompt.ask('Start the gateway now? (Y/n)', 'y');
    if (/^y/i.test(answer) || answer === '') return cmdUp({ ...flags, config: result.configPath });
    console.log(`Fine — run \`${RUN_AS} start\` when you want it.`);
  } finally {
    prompt?.close();
  }
}

async function cmdUp(flags) {
  // `sui start` is the one place background jobs run.
  //
  // --role and --model-plane override the config for one run, because the
  // two-plane split (B5.7) is a deployment choice, not a property of the file:
  // the same config should be startable as either half.
  const role = flags.role ? String(flags.role) : undefined;
  if (role && !['both', 'model', 'agent'].includes(role)) {
    throw new ConfigError(`Unknown plane role "${role}". Use one of: both, model, agent.`, { path: 'planes.role' });
  }

  const configOverride = {};
  // --headless: the proxy engine only, no dashboard. A gateway on a VPS should
  // not serve a page that can rewrite its own config.
  if (flags.headless === true) configOverride.headless = true;
  if (role) configOverride.planes = { ...(configOverride.planes ?? {}), role };
  if (flags['model-plane']) {
    configOverride.planes = { ...(configOverride.planes ?? {}), modelPlaneUrl: String(flags['model-plane']) };
  }

  const gateway = await createGateway({
    configPath: flags.config,
    startWorkers: flags['no-workers'] !== true,
    ...(Object.keys(configOverride).length ? { configOverride } : {}),
  });
  const { config, server } = gateway;

  // An open relay: bound to the network, no key, so anyone who can reach the port
  // spends your quota and reads your traffic. Refuse unless asked explicitly.
  const bindsPublicly = !['127.0.0.1', 'localhost', '::1'].includes(String(config.server.host));
  if (bindsPublicly && !(config.apiKeys ?? []).length && flags['allow-open'] !== true) {
    throw new ConfigError(
      `Refusing to serve on ${config.server.host} with no API keys: anyone who can reach this port could spend your quota. ` +
        `Add an apiKeys entry to the config, or pass --allow-open if this network is trusted.`,
      { path: 'server.host' },
    );
  }
  if (bindsPublicly && !(config.apiKeys ?? []).length) {
    console.warn(`  warning: serving on ${config.server.host} with no API keys (--allow-open). Anyone on this network can use your providers.`);
  }
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
        `Port ${port} is already in use. Either stop what is on it, or start sui elsewhere: ${RUN_AS} start --port ${port + 1}`,
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
  // The port the server actually bound, not the one that was asked for: `--port 0`
  // means "any free port", and printing 0 sends the user to a URL that cannot work.
  const bound = server.address()?.port ?? port;
  console.log(`sui ${VERSION} is up`);
  console.log(`  endpoint   http://${shown}:${bound}/v1`);
  console.log(`  dashboard  http://${shown}:${bound}/`);
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


/**
 * What the gateway can see about each key, without printing the key.
 *
 * "rejected the API key" is true and useless when the key is fine and a trailing
 * space is not. Length and cleanliness are enough to tell those apart, and neither
 * reveals the secret.
 */
function credentialRows(config) {
  const rows = [];
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    const prov = /** @type {any} */ (provider);
    const envName = prov.apiKeyEnv;
    if (!envName) continue;
    const raw = process.env[envName];
    if (!raw) {
      rows.push([envName, 'not set', id, '']);
      continue;
    }
    const clean = sanitiseKey(raw);
    const dirty = clean !== String(raw).trim() || clean !== String(raw);
    rows.push([
      envName,
      `${String(clean ?? '').length} chars`,
      id,
      clean ? (dirty ? 'had spaces or quotes — cleaned' : 'clean') : 'empty after cleaning',
    ]);
  }
  return rows;
}

async function cmdDoctor(flags) {
  // `doctor` is the health check, so a missing config is something it should
  // diagnose rather than something it should refuse to look at. Refusing turned the
  // most natural first command into a dead end: "no config found" and nothing else.
  // defaultConfigPath() answers null when nothing exists; the useful thing to print
  // is where a config *would* go, not the word "null".
  const configPath = flags.config ?? defaultConfigPath() ?? join(suiHome(process.env), 'sui.config.json');
  if (!existsSync(configPath)) {
    const keys = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY'].filter(
      (name) => process.env[name],
    );
    const catalogue = (() => {
      try {
        return loadCatalogue().length;
      } catch {
        return 0;
      }
    })();

    console.log('');
    console.log('sui doctor — what this machine has');
    console.log('');
    console.log(table(
      ['check', 'result'],
      [
        ['node', process.version],
        ['config', `none — a config would live at ${configPath}`],
        ['provider keys in this window', keys.length ? keys.join(', ') : 'none'],
        ['catalogue', `${catalogue} entries`],
      ],
    ));
    console.log('');
    console.log('  Everything above is fine — there is simply no config yet.');
    console.log(`  Create one, which also proves the route:  ${RUN_AS} init`);
    console.log('  Then this command will test every combo against your key.');
    console.log('');
    return;
  }

  const gateway = await createGateway({ configPath: flags.config, ledgerFile: null });
  const { config, router } = gateway;
  const combos = flags.combo ? [String(flags.combo)] : Object.keys(config.combos);

  console.log('');
  console.log('sui doctor — one real turn per combo');
  console.log('');

  const creds = credentialRows(config);
  if (creds.length) {
    console.log(table(['key', 'length', 'provider', 'state'], creds));
    const suspect = creds.filter((row) => row[3] && row[3] !== 'clean');
    for (const row of suspect) {
      console.log(`  ${row[0]}: ${row[3]} — a key with a space or a quote in it is rejected by every provider`);
    }
    if (creds.every((row) => row[1] === 'not set')) console.log('  no provider keys are set in this window');
    console.log('');
  }

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
  if (failing.length) console.log(`\n${failing.length} invariant warning(s) — see docs/ARCHITECTURE.md and \`${RUN_AS} invariants\`.`);
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
    console.log(`Export: ${RUN_AS} cost --export usage.csv [--gzip]   (or the dashboard's Export CSV)`);
  }
}

async function cmdTools(flags, args) {
  const tools = detectTools({ env: loadEnvFile('.env', { ...process.env }) });
  const want = flags.set ?? args[0];

  if (want) {
    const configPath = defaultConfigPath();
    const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
    if (!config) throw new ConfigError(`No config yet. Run \`${RUN_AS} init\` first.`);
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
  console.log(`Point one at the gateway:  ${RUN_AS} tools --set continue`);
  console.log('Available ids: ' + tools.map((t) => t.id).join(', '));
}

async function cmdMigrate(flags, args) {
  const file = args[0] ?? flags.from;
  if (!file) {
    throw new ConfigError(`Say which config to import: ${RUN_AS} migrate ./9router.json`);
  }
  const imported = readMigrationSource(resolve(file));
  const configPath = flags.config ?? defaultConfigPath();
  if (!configPath) throw new ConfigError(`No sui config yet. Run \`${RUN_AS} init\` first.`);
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
    console.log(`Usage: ${RUN_AS} keys hash [--config <file>]`);
    console.log('');
    console.log('Rewrites every plaintext key in apiKeys as a SHA-256 hash. The keys');
    console.log('themselves still work — they are simply no longer stored in the file.');
    return;
  }
  const path = flags.config ?? defaultConfigPath();
  if (!path) throw new ConfigError(`No config found. Run \`${RUN_AS} init\` first.`);
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
  if (!resolved) throw new ConfigError(`No config found. Run \`${RUN_AS} init\` first.`);
  return normalizeConfig(JSON.parse(readFileSync(resolved, 'utf8')), { path: resolved, env: loadEnvFile('.env', { ...process.env }) });
}

function help() {
  console.log(`
sui ${VERSION} — ${t('app.tagline')}

  ${RUN_AS}                first run: find keys, find tools, prove the route, start
  ${RUN_AS} init           the same, explicitly      --demo  --force  --port 8787
  ${RUN_AS} start          run the gateway            --port 8787  --config <file>  --no-workers  --headless  --allow-open
                          (aliases: up, serve)
  ${RUN_AS} invariants     every hard constraint, and which are enforced
  ${RUN_AS} keys hash       replace plaintext API keys with SHA-256 hashes
  ${RUN_AS} doctor          one real turn per combo, and say what broke
  ${RUN_AS} models          the combos and what they can reach   --json
  ${RUN_AS} cost            spend, latency and A/B arms           --json  --all   (alias: usage)
                          --by user|tool for charge-back attribution
  ${RUN_AS} tools           point a coding tool here              --set <tool-id>
  ${RUN_AS} migrate <file>  import from 9router / OmniRoute / HubGate   --apply  --only a,b
  ${RUN_AS} catalog [q]    the provider catalogue, and what is still unverified
  ${RUN_AS} free-budget    verified free headroom per month, and what is only a claim
  ${RUN_AS} lang            the languages this build speaks   (SUI_LANG=hi, gu, mr, ta, te)
                          (alias: languages)
  ${RUN_AS} probe [name]   liveness, readiness and suitability checks (B2.3)
  ${RUN_AS} compress <file|-> [--preset lite|standard|aggressive|ultra] [--text "…"]
  ${RUN_AS} budget         which preset the remaining quota would choose
  ${RUN_AS} savings        what cache hits and compression did not spend   --all
  ${RUN_AS} explain [combo] why a route would go where it goes (B7.4)
  ${RUN_AS} tenants        what each API key has spent, and what it may reach
  ${RUN_AS} mcp            serve the gateway over MCP   --transport stdio|http  --port 8788
  ${RUN_AS} recipe list    named config patches: list, show, apply  --dry-run  --force
  ${RUN_AS} local          find a model server on this machine   --write  --timeout 300
  ${RUN_AS} sandbox        run code in a contained process       --self-test  --wall  --heap
  ${RUN_AS} redteam [combo] attack your own route with 10 obfuscations (B6.2)
  ${RUN_AS} vault <cmd>    init | set <provider> | list | remove <provider> | status
  ${RUN_AS} config <cmd>   show | get <path> | set <path> <value> | unset <path>
  ${RUN_AS} tokens --check WCAG AA on the dashboard tokens, computed by tokens-kit
  ${RUN_AS} kits           the vendored kits and whether they load

Endpoint, once running:   http://127.0.0.1:8787/v1
Dashboard:                http://127.0.0.1:8787/
Docs:                     docs/ARCHITECTURE.md, docs/ROUTING.md, docs/MIGRATION.md
`);
}

/* ------------------------------------------------------------------- helpers */

/** Flags that take a value, so `--config ./x.json` works as well as `--config=./x.json`. */
const VALUE_FLAGS = new Set(['config', 'port', 'set', 'only', 'from', 'combo', 'env', 'export', 'provider', 'key', 'q', 'preset', 'text', 'out', 'fraction', 'timeout', 'by', 'transport', 'wall', 'heap', 'file', 'role', 'model-plane']);

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
