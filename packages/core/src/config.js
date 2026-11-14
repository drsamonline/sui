/**
 * Config loading, validation and normalisation.
 *
 * Rules of the house:
 *  - every validation failure names the exact field and says what to do instead
 *  - nothing throws at request time that could have thrown at load time
 *  - a provider with no credentials is *skipped*, never a crash
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError } from './errors.js';

export const STRATEGIES = ['fallback', 'weighted', 'cheapest', 'latency'];
export const PROVIDER_TYPES = ['openai', 'anthropic', 'gemini', 'mock'];

export function suiHome(env = process.env) {
  return env.SUI_HOME ? resolve(env.SUI_HOME) : join(homedir(), '.sui');
}

export function defaultConfigPath(env = process.env) {
  const candidates = [
    env.SUI_CONFIG,
    join(process.cwd(), 'sui.config.json'),
    join(process.cwd(), 'config', 'sui.config.json'),
    join(suiHome(env), 'sui.config.json'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return resolve(c);
  return null;
}

/**
 * @param {string} [path]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(path, env = process.env) {
  const resolved = path ? resolve(path) : defaultConfigPath(env);
  if (!resolved) {
    throw new ConfigError(
      'No sui config found. Run `npx sui init` to create one, or pass --config <file>.',
      { path: 'SUI_CONFIG' },
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `Could not read the config at ${resolved}. It must be valid JSON.`,
      { detail: /** @type {Error} */ (err).message, path: resolved },
    );
  }
  return normalizeConfig(raw, { path: resolved, env });
}

/**
 * @param {any} raw
 * @param {{path?: string, env?: NodeJS.ProcessEnv}} [opts]
 */
export function normalizeConfig(raw, opts = {}) {
  const env = opts.env ?? process.env;
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Config must be a JSON object.', { path: 'root' });
  }

  const config = {
    path: opts.path ?? null,
    server: {
      host: raw.server?.host ?? '127.0.0.1',
      port: Number(raw.server?.port ?? 8787),
      // I15: a request whose Host header is not on this list is refused. Without
      // it, DNS rebinding turns a localhost gateway into a remote one.
      allowedHosts: Array.isArray(raw.server?.allowedHosts) ? raw.server.allowedHosts : null,
      cache: {
        enabled: raw.server?.cache?.enabled ?? true,
        ttlMs: Number(raw.server?.cache?.ttlMs ?? 900000),
        maxEntries: Number(raw.server?.cache?.maxEntries ?? 500),
      },
    },
    providers: raw.providers ?? {},
    models: raw.models ?? {},
    combos: raw.combos ?? {},
    breaker: {
      failures: Number(raw.breaker?.failures ?? 3),
      cooldownMs: Number(raw.breaker?.cooldownMs ?? 30000),
      halfOpenSuccesses: Number(raw.breaker?.halfOpenSuccesses ?? 1),
    },
    budgets: {
      dailyUsd: raw.budgets?.dailyUsd ?? null,
      warnAtPct: Number(raw.budgets?.warnAtPct ?? 80),
      perProvider: raw.budgets?.perProvider ?? {},
    },
    guardrails: {
      maxOutputTokens: Number(raw.guardrails?.maxOutputTokens ?? 4096),
      maxInputChars: Number(raw.guardrails?.maxInputChars ?? 400000),
      blockPatterns: Array.isArray(raw.guardrails?.blockPatterns) ? raw.guardrails.blockPatterns : [],
      logPrompts: raw.guardrails?.logPrompts ?? false,
      redactPiiInLogs: raw.guardrails?.redactPiiInLogs ?? true,
    },
    // B4.1/B4.3: prompt compression. Off by default — it changes what the model
    // sees, so it is a decision, not a default.
    compression: {
      enabled: raw.compression?.enabled === true,
      preset: raw.compression?.preset ?? 'auto',
      minChars: Number(raw.compression?.minChars ?? 400),
      keepLastUserMessage: raw.compression?.keepLastUserMessage !== false,
    },
    // B9.1: background jobs. Off-path by construction — nothing here may run
    // during a request (I1).
    workers: {
      enabled: raw.workers?.enabled !== false,
      kickoffMs: Number(raw.workers?.kickoffMs ?? 1500),
      cacheSweepMs: Number(raw.workers?.cacheSweepMs ?? 300000),
      prober: {
        enabled: raw.workers?.prober?.enabled !== false,
        intervalMs: Number(raw.workers?.prober?.intervalMs ?? 3600000),
        failuresBeforeDisable: Number(raw.workers?.prober?.failuresBeforeDisable ?? 3),
        timeoutMs: Number(raw.workers?.prober?.timeoutMs ?? 8000),
      },
    },
    apiKeys: Array.isArray(raw.apiKeys) ? raw.apiKeys : [],
    // I4: the paid air-gap. Closed by default; a paid provider's credentials are
    // never read while it is closed, whatever is in the environment.
    paidTiers: {
      enabled: raw.paid_tiers?.enabled === true || raw.paidTiers?.enabled === true,
      vaultPath: raw.paid_tiers?.vaultPath ?? raw.paidTiers?.vaultPath ?? null,
    },
    env,
  };

  validateConfig(config);
  return config;
}

/** @param {any} config */
export function validateConfig(config) {
  const problems = [];

  if (!Object.keys(config.providers).length) {
    problems.push('providers is empty — add at least one provider (groq, gemini, openai, anthropic, ollama…).');
  }

  for (const [id, p] of Object.entries(config.providers)) {
    const prov = /** @type {any} */ (p);
    if (!PROVIDER_TYPES.includes(prov.type)) {
      problems.push(
        `providers.${id}.type is "${prov.type}" — use one of: ${PROVIDER_TYPES.join(', ')}.`,
      );
    }
    if ((prov.type === 'openai' || prov.type === 'anthropic') && !prov.baseUrl) {
      problems.push(`providers.${id}.baseUrl is required for type "${prov.type}".`);
    }
    if (prov.type === 'mock' && !prov.baseUrl) {
      // mock providers are fine without a URL; they answer in-process
    }
    if (prov.timeoutMs != null && (!Number.isFinite(Number(prov.timeoutMs)) || Number(prov.timeoutMs) <= 0)) {
      problems.push(`providers.${id}.timeoutMs must be a positive number of milliseconds.`);
    }
  }

  if (!Object.keys(config.models).length) {
    problems.push('models is empty — declare at least one model.');
  }

  for (const [id, m] of Object.entries(config.models)) {
    const model = /** @type {any} */ (m);
    if (!model.provider) problems.push(`models.${id}.provider is missing.`);
    else if (!config.providers[model.provider]) {
      problems.push(`models.${id}.provider "${model.provider}" is not declared in providers.`);
    }
    if (!model.model) problems.push(`models.${id}.model is missing (the provider's own model name).`);
    for (const field of ['costPer1kIn', 'costPer1kOut']) {
      if (model[field] != null && (!Number.isFinite(Number(model[field])) || Number(model[field]) < 0)) {
        problems.push(`models.${id}.${field} must be zero or a positive number.`);
      }
    }
    if (model.quality != null && (Number(model.quality) < 1 || Number(model.quality) > 5)) {
      problems.push(`models.${id}.quality must be between 1 and 5.`);
    }
  }

  if (!Object.keys(config.combos).length) {
    problems.push('combos is empty — add at least one combo (a virtual model name your tools call).');
  }

  for (const [id, c] of Object.entries(config.combos)) {
    const combo = /** @type {any} */ (c);
    if (!STRATEGIES.includes(combo.strategy)) {
      problems.push(`combos.${id}.strategy is "${combo.strategy}" — use one of: ${STRATEGIES.join(', ')}.`);
    }
    if (!Array.isArray(combo.targets) || combo.targets.length === 0) {
      problems.push(`combos.${id}.targets must list at least one model.`);
      continue;
    }
    for (const t of combo.targets) {
      const ref = typeof t === 'string' ? t : t?.model;
      if (!ref) {
        problems.push(`combos.${id}.targets has an entry with no model name.`);
        continue;
      }
      if (!config.models[ref]) {
        problems.push(`combos.${id} points at model "${ref}", which is not declared in models.`);
      }
      if (typeof t === 'object' && t.weight != null && (!Number.isFinite(Number(t.weight)) || Number(t.weight) <= 0)) {
        problems.push(`combos.${id} target "${ref}" has a weight that must be a positive number.`);
      }
    }
    if (combo.strategy === 'weighted' && combo.targets.every((t) => typeof t === 'string')) {
      problems.push(`combos.${id} uses strategy "weighted" but its targets have no weights.`);
    }
  }

  for (const [i, k] of config.apiKeys.entries()) {
    if (!k.key && !k.key_hash) problems.push(`apiKeys[${i}] needs either key_hash (preferred) or key.`);
    if (k.key_hash && !/^[a-f0-9]{64}$/.test(String(k.key_hash))) {
      problems.push(`apiKeys[${i}].key_hash must be a 64-character SHA-256 hex digest.`);
    }
    if (k.allowedCombos && !Array.isArray(k.allowedCombos)) {
      problems.push(`apiKeys[${i}].allowedCombos must be an array of combo names.`);
    }
  }

  if (problems.length) {
    throw new ConfigError(
      `The config has ${problems.length} problem${problems.length === 1 ? '' : 's'} to fix:\n  - ${problems.join('\n  - ')}`,
      { path: config.path ?? undefined },
    );
  }
  return true;
}

/**
 * Is this a paid-tier provider?
 * @param {any} provider
 */
export function isPaidProvider(provider) {
  return Boolean(provider && (provider.tier === 'paid' || provider.paid === true));
}

/**
 * Can this provider be called at all?
 *
 * `apiKeyEnv: null` is an explicit "this endpoint needs no key" (Ollama, vLLM,
 * LM Studio, a test double). Leaving apiKeyEnv out entirely means "we do not
 * know of a key", which is different, and is treated as not ready.
 *
 * I4: when the config is supplied and the paid gate is closed, a paid provider
 * reports no credentials. Its key is never read — the gate is checked before
 * the environment is touched, not after.
 *
 * @param {any} provider
 * @param {NodeJS.ProcessEnv} [env]
 * @param {any} [config]
 */
export function providerHasCredentials(provider, env = process.env, config = null) {
  if (!provider) return false;
  if (config && isPaidProvider(provider) && config.paidTiers?.enabled !== true) return false;
  if (provider.type === 'mock') return true;
  if (provider.local) return true;
  if (provider.apiKey) return true;
  if (provider.apiKeyEnv === null) return true;
  if (!provider.apiKeyEnv) return false;
  return Boolean(env[provider.apiKeyEnv]);
}

/** SHA-256 of an API key. What we store, instead of the key. */
export function hashApiKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

/**
 * Constant-time check of a presented key against a stored entry.
 * Accepts `key_hash` (preferred) or a plaintext `key` (legacy, reported by the
 * invariant audit so it gets rotated).
 *
 * @param {string} presented
 * @param {any} entry
 */
export function verifyApiKey(presented, entry) {
  if (!presented || !entry) return false;
  const presentedHash = Buffer.from(hashApiKey(presented), 'hex');
  const expected = entry.key_hash
    ? Buffer.from(String(entry.key_hash), 'hex')
    : Buffer.from(hashApiKey(String(entry.key ?? '')), 'hex');
  if (presentedHash.length !== expected.length) return false;
  return timingSafeEqual(presentedHash, expected);
}

/** @param {any} config */
export function availableModels(config) {
  return Object.entries(config.models)
    .filter(([, m]) => providerHasCredentials(config.providers[/** @type {any} */ (m).provider], config.env, config))
    .map(([id]) => id);
}

/**
 * Turn the raw target list of a combo into a normalised plan.
 * @param {any} config
 * @param {string} comboName
 */
export function resolveCombo(config, comboName) {
  const combo = config.combos[comboName];
  if (!combo && config.models[comboName]) {
    // A bare model id is callable too: it routes to exactly that model.
    return {
      name: comboName,
      label: config.models[comboName].label ?? comboName,
      strategy: 'fallback',
      minQuality: 1,
      maxCostPer1k: null,
      targets: [{ modelId: comboName, model: config.models[comboName], weight: 1, arm: null }],
    };
  }
  if (!combo) {
    const known = Object.keys(config.combos).join(', ');
    throw new ConfigError(`Unknown model "${comboName}". Available: ${known}.`, { path: 'combos' });
  }
  const targets = combo.targets.map((t) => {
    const id = typeof t === 'string' ? t : t.model;
    const model = config.models[id];
    return {
      modelId: id,
      model: /** @type {any} */ (model),
      weight: typeof t === 'object' && t.weight != null ? Number(t.weight) : 1,
      arm: typeof t === 'object' && t.arm ? t.arm : (typeof t === 'object' ? id : null),
    };
  });
  return {
    name: comboName,
    label: combo.label ?? comboName,
    strategy: combo.strategy,
    minQuality: combo.minQuality ?? 1,
    maxCostPer1k: combo.maxCostPer1k ?? null,
    targets,
  };
}

/** Cost of a turn in USD, from the model's own declared prices. */
export function estimatedCost(model, promptTokens, completionTokens) {
  const inCost = (Number(model?.costPer1kIn ?? 0) * promptTokens) / 1000;
  const outCost = (Number(model?.costPer1kOut ?? 0) * completionTokens) / 1000;
  return Math.round((inCost + outCost) * 1e6) / 1e6;
}

/** Rough token estimate, used for budget checks before a call. ~4 chars per token. */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

/** Config with every secret removed — safe for the dashboard and logs. */
export function sanitizeConfig(config) {
  return {
    path: config.path,
    server: config.server,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, p]) => {
        const prov = /** @type {any} */ (p);
        return [
          id,
          {
            type: prov.type,
            baseUrl: prov.baseUrl ?? null,
            apiKeyEnv: prov.apiKeyEnv ?? null,
            local: Boolean(prov.local),
            hasCredentials: providerHasCredentials(prov, config.env, config),
            tier: prov.tier ?? 'free',
            tos: prov.tos ?? 'review',
            timeoutMs: prov.timeoutMs ?? null,
          },
        ];
      }),
    ),
    models: config.models,
    combos: config.combos,
    breaker: config.breaker,
    budgets: config.budgets,
    guardrails: config.guardrails,
    paidTiers: { enabled: config.paidTiers?.enabled === true },
    workers: config.workers,
    compression: config.compression,
    apiKeyCount: config.apiKeys.length,
  };
}

/**
 * Toggle validation — the dashboard's commit gate.
 *
 * A switch may only be committed if every dependency it needs exists. This is
 * deliberately a pure function so the UI and the CLI agree on the answer.
 *
 * @param {any} config
 * @param {{disableProvider?: string, disableModel?: string, enableCombo?: string, deleteCombo?: string}} patch
 * @returns {{ok: boolean, blockers: Array<{code: string, message: string, fix: string}>}}
 */
export function checkToggle(config, patch) {
  /** @type {Array<{code: string, message: string, fix: string}>} */
  const blockers = [];

  const combosUsing = (modelId) =>
    Object.entries(config.combos)
      .filter(([, c]) => /** @type {any} */ (c).targets.some((t) => (typeof t === 'string' ? t : t.model) === modelId))
      .map(([id]) => id);

  if (patch.disableModel) {
    const used = combosUsing(patch.disableModel);
    if (used.length) {
      blockers.push({
        code: 'model_in_use',
        message: `"${patch.disableModel}" is still a target of: ${used.join(', ')}.`,
        fix: `Remove it from ${used.length === 1 ? 'that combo' : 'those combos'} first, or point them at a replacement model.`,
      });
    }
  }

  if (patch.disableProvider) {
    const models = Object.entries(config.models)
      .filter(([, m]) => /** @type {any} */ (m).provider === patch.disableProvider)
      .map(([id]) => id);
    const combos = [...new Set(models.flatMap(combosUsing))];
    if (models.length) {
      blockers.push({
        code: 'provider_in_use',
        message: `Provider "${patch.disableProvider}" still backs ${models.length} model${models.length === 1 ? '' : 's'} (${models.join(', ')}).`,
        fix: combos.length
          ? `Combos ${combos.join(', ')} would lose ${combos.length === 1 ? 'a target' : 'targets'}. Disable or re-point those models first.`
          : 'Disable or re-point those models first.',
      });
    }
  }

  if (patch.enableCombo) {
    if (!config.combos[patch.enableCombo]) {
      blockers.push({
        code: 'combo_missing',
        message: `Combo "${patch.enableCombo}" is not defined in the config.`,
        fix: 'Add it under combos, then enable it.',
      });
    }
  }

  return { ok: blockers.length === 0, blockers };
}
