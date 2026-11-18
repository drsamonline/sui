/**
 * First-run onboarding.
 *
 * The one rule this file exists to enforce: onboarding may not report success
 * without a real model round-trip. A green tick here means a request left this
 * machine and an answer came back — not that a config file was written.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, loadEnvFile } from '@drsamonline/gateway';
import { providerHasCredentials, suiHome } from '@drsamonline/core';
import { detectTools, writeToolConfig } from './tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', '..', '..', 'config', 'sui.config.json');

const PROVIDER_KEYS = [
  { id: 'groq', env: 'GROQ_API_KEY', note: 'has a free tier' },
  { id: 'gemini', env: 'GEMINI_API_KEY', note: 'has a free tier' },
  { id: 'openai', env: 'OPENAI_API_KEY', note: 'paid' },
  { id: 'anthropic', env: 'ANTHROPIC_API_KEY', note: 'paid' },
  { id: 'openrouter', env: 'OPENROUTER_API_KEY', note: 'free models available' },
];

/**
 * @param {{
 *   cwd?: string, env?: NodeJS.ProcessEnv, interactive?: boolean,
 *   out?: (line?: string) => void, prompt?: {ask: Function, choose: Function},
 *   force?: boolean, demo?: boolean, port?: number, template?: any
 * }} [opts]
 */
export async function runInit(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? loadEnvFile(join(cwd, '.env'), { ...process.env });
  const out = opts.out ?? ((line = '') => console.log(line));
  const interactive = opts.interactive ?? false;
  const configPath = join(cwd, 'sui.config.json');

  out('');
  out('sui · first run');
  out('');

  // 1. what can we reach?
  out('Looking for provider keys…');
  /** @type {Array<{id: string, env: string, note: string, present: boolean}>} */
  const keys = PROVIDER_KEYS.map((p) => ({ ...p, present: Boolean(env[p.env]) }));
  for (const k of keys) {
    out(`  ${k.present ? 'found  ' : 'missing'}  ${k.env.padEnd(22)} ${k.note}`);
  }

  let template = opts.template ?? null;
  if (!template) {
    try {
      template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    } catch {
      template = { providers: {}, models: {}, combos: {}, server: { host: '127.0.0.1', port: opts.port ?? 8787 } };
    }
  }

  // A keyless provider (Ollama, LM Studio) only counts if it is actually
  // running — otherwise the first run would "succeed" against nothing.
  const usableProviders = [];
  for (const [id, p] of Object.entries(template.providers ?? {})) {
    const prov = /** @type {any} */ (p);
    const keyed = Boolean(prov.apiKeyEnv && env[prov.apiKeyEnv]) || Boolean(prov.apiKey);
    if (keyed) {
      usableProviders.push(id);
      continue;
    }
    if (prov.apiKeyEnv === null || prov.local) {
      if (await isReachable(prov.baseUrl)) usableProviders.push(id);
      else out(`  ${id} is configured but not answering at ${prov.baseUrl} — leaving it out`);
    }
  }

  const demo = opts.demo || usableProviders.length === 0;
  let config = filterConfig(template, usableProviders);

  if (demo) {
    out('');
    out('No provider keys are set, so I am wiring a demo provider.');
    out('It answers in-process: it proves the gateway, the dashboard and your tools');
    out('all work, but it is not a real model. Add a key and re-run to switch over.');
    config = demoConfig(template, opts.port ?? 8787);
  }

  if (config.portOverride) {
    config.server.port = config.portOverride;
    delete config.portOverride;
  }

  // 2. what will this machine call it from?
  out('');
  out('Looking for coding tools…');
  const tools = detectTools({ env });
  const detected = tools.filter((t) => t.detected && t.id !== 'env');
  if (detected.length) {
    for (const t of detected) out(`  found  ${t.name.padEnd(28)} ${t.setup === 'file' ? 'config file' : 'paste two fields'}`);
  } else {
    out('  none found — that is fine, anything that speaks OpenAI can use the endpoint.');
  }

  // 3. write config
  const exists = existsSync(configPath);
  if (exists && !opts.force) {
    const backup = `${configPath}.bak-${Date.now()}`;
    copyFileSync(configPath, backup);
    out('');
    out(`Existing config kept as ${backup}.`);
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  out('');
  out(`Config written: ${configPath}`);

  const comboNames = Object.keys(config.combos ?? {});
  out(`Combos: ${comboNames.join(', ')}`);

  // 4. the part that matters: a real turn
  out('');
  out('Checking the route end to end…');
  const gateway = await createGateway({ configPath, env, ledgerFile: join(suiHome(env), 'ledger.jsonl') });

  const combo = comboNames.includes('chat-default') ? 'chat-default' : comboNames[0];
  const started = Date.now();
  let roundTrip;
  try {
    const res = await gateway.router.chat({
      combo,
      body: { messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 24 },
    });
    roundTrip = {
      ok: true,
      combo,
      provider: res.meta.provider,
      modelId: res.meta.modelId,
      model: res.meta.model,
      verified: res.meta.verified,
      latencyMs: res.meta.latencyMs,
      text: res.text.trim().slice(0, 120),
      costUsd: res.meta.costUsd,
    };
    out(`  answered by ${res.meta.modelId} (${res.meta.provider}) in ${res.meta.latencyMs} ms`);
    out(`  reply: "${roundTrip.text}"`);
    if (!res.meta.verified) {
      out('  note: this came from the demo provider, not a real upstream model.');
    }
  } catch (err) {
    roundTrip = { ok: false, combo, error: /** @type {any} */ (err).message, ms: Date.now() - started };
    out(`  failed: ${roundTrip.error}`);
    out('');
    out('Nothing was marked ready. Fix the problem above and run `npx sui init` again.');
    return { ok: false, configPath, config, roundTrip, tools };
  }

  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  const endpoint = `http://${host}:${config.server.port}/v1`;

  out('');
  out('Endpoint ready');
  out(`  ${endpoint}`);
  out(`  OPENAI_BASE_URL=${endpoint}`);
  out(`  OPENAI_API_KEY=${config.apiKeys?.[0]?.key ?? 'any-non-empty-string'}`);
  out(`  dashboard: http://${host}:${config.server.port}/`);

  // 5. one-click tool setup, offered once
  let toolResult = null;
  if (interactive && detected.length && opts.prompt) {
    const choice = await opts.prompt.choose(
      'Point a tool at it now?',
      [...detected.map((t) => t.name), 'Not now'],
    );
    const picked = detected.find((t) => t.name === choice);
    if (picked) {
      toolResult = writeToolConfig(picked.id, {
        baseUrl: `http://${host}:${config.server.port}`,
        combo,
        apiKey: config.apiKeys?.[0]?.key ?? 'sui-local',
        env,
      });
      out(`  ${toolResult.message}`);
      if (toolResult.snippet) out(indent(toolResult.snippet, '    '));
    }
  } else if (detected.length) {
    out('');
    out('Next: `npx sui tools` to point one of these at the gateway.');
  }

  return { ok: true, configPath, config, roundTrip, endpoint, tools, toolResult, demo };
}

/**
 * Keep only providers we have credentials for (plus local ones), then drop
 * models and combos that lost their backing.
 */
export function filterConfig(template, providerIds) {
  const keep = new Set(providerIds);
  const providers = Object.fromEntries(Object.entries(template.providers ?? {}).filter(([id]) => keep.has(id)));
  const models = Object.fromEntries(
    Object.entries(template.models ?? {}).filter(([, m]) => keep.has(/** @type {any} */ (m).provider)),
  );
  const modelIds = new Set(Object.keys(models));
  const combos = {};
  for (const [id, c] of Object.entries(template.combos ?? {})) {
    const combo = /** @type {any} */ (c);
    const targets = combo.targets.filter((t) => modelIds.has(typeof t === 'string' ? t : t.model));
    if (targets.length) combos[id] = { ...combo, targets };
  }
  return {
    ...template,
    providers,
    models,
    combos: Object.keys(combos).length
      ? combos
      : { 'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: [...modelIds].slice(0, 1) } },
    server: { ...(template.server ?? {}), port: template.server?.port ?? 8787 },
    apiKeys: [],
  };
}

function demoConfig(template, port) {
  return {
    ...template,
    providers: {
      demo: { type: 'mock', mock: { delayMs: 10 } },
    },
    models: {
      'demo-model': {
        provider: 'demo',
        model: 'demo-model',
        label: 'Built-in demo model (no key needed)',
        costPer1kIn: 0,
        costPer1kOut: 0,
        quality: 1,
        tier: 'demo',
      },
    },
    combos: {
      'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['demo-model'] },
    },
    server: { ...(template.server ?? {}), port },
    apiKeys: [],
  };
}

/** Is a keyless local endpoint actually up? Short timeout, never fatal. */
async function isReachable(baseUrl) {
  if (!baseUrl) return false;
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/models', { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

function indent(text, pad) {
  return String(text)
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
