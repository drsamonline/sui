/**
 * Migration from another router.
 *
 * The importer is shape-based, not schema-locked: it looks for the concepts
 * every router has (providers with a base URL, model entries, virtual models /
 * aliases / combos) under the names they are commonly given. Anything it cannot
 * place is reported by key name instead of being dropped quietly.
 *
 * Nothing is written until you have seen the diff and chosen what to import.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ConfigError } from '@sui/core';

const PROVIDER_ALIAS_KEYS = ['providers', 'connections', 'upstreams', 'channels', 'endpoints'];
const MODEL_KEYS = ['models', 'modelMap', 'model_map'];
const COMBO_KEYS = ['combos', 'aliases', 'routes', 'virtualModels', 'virtual_models', 'groups', 'profiles'];

/**
 * @param {string} path
 * @returns {{source: string, file: string, providers: Record<string, any>, models: Record<string, any>, combos: Record<string, any>, warnings: string[], unknownKeys: string[]}}
 */
export function readMigrationSource(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Could not open ${path}. Check the path and try again.`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `${basename(path)} is not JSON. YAML configs need converting first (most tools have an "export config" button that writes JSON).`,
      { path },
    );
  }
  if (!json || typeof json !== 'object') {
    throw new ConfigError(`${basename(path)} does not contain a config object.`, { path });
  }

  const find = (keys) => keys.find((k) => json[k] && typeof json[k] === 'object');
  const providerKey = find(PROVIDER_ALIAS_KEYS);
  const modelKey = find(MODEL_KEYS);
  const comboKey = find(COMBO_KEYS);

  /** @type {Record<string, any>} */
  const providers = {};
  /** @type {Record<string, any>} */
  const models = {};
  /** @type {Record<string, any>} */
  const combos = {};
  /** @type {string[]} */
  const warnings = [];

  const source = guessSource(path, json);

  if (providerKey) {
    const container = json[providerKey];
    const entries = Array.isArray(container)
      ? container.map((p, i) => [p.name ?? p.id ?? `provider-${i}`, p])
      : Object.entries(container);
    for (const [id, p] of entries) {
      const prov = /** @type {any} */ (p);
      const baseUrl = prov.baseUrl ?? prov.base_url ?? prov.baseURL ?? prov.api_base ?? prov.apiBase ?? prov.url ?? null;
      const keyName = prov.apiKeyEnv ?? prov.api_key_env ?? null;
      const literalKey = prov.apiKey ?? prov.api_key ?? prov.key ?? null;
      const type = normaliseType(prov.type ?? prov.kind ?? prov.format ?? guessType(baseUrl));
      providers[id] = {
        type,
        ...(baseUrl ? { baseUrl } : {}),
        ...(keyName ? { apiKeyEnv: keyName } : literalKey ? { apiKeyEnv: `${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY` } : {}),
        ...(prov.timeoutMs ?? prov.timeout ? { timeoutMs: Number(prov.timeoutMs ?? prov.timeout) } : {}),
      };
      if (literalKey) {
        warnings.push(
          `Provider "${id}" had its key written into the old config. I set apiKeyEnv instead — put the key in .env as ${providers[id].apiKeyEnv}.`,
        );
      }
      if (!baseUrl && type !== 'gemini' && type !== 'mock') {
        warnings.push(`Provider "${id}" has no base URL; it will need one before it can be used.`);
      }
    }
  } else {
    warnings.push(`No provider list found (looked for: ${PROVIDER_ALIAS_KEYS.join(', ')}).`);
  }

  if (modelKey) {
    const container = json[modelKey];
    const entries = Array.isArray(container)
      ? container.map((m, i) => [m.id ?? m.name ?? `model-${i}`, m])
      : Object.entries(container);
    for (const [id, m] of entries) {
      const model = /** @type {any} */ (m);
      const providerRef = model.provider ?? model.providerId ?? model.upstream ?? model.connection ?? null;
      if (!providerRef) {
        warnings.push(`Model "${id}" does not say which provider it belongs to; skipped.`);
        continue;
      }
      models[id] = {
        provider: providerRef,
        model: model.model ?? model.upstreamModel ?? model.upstream_model ?? model.name ?? id,
        ...(model.costPer1kIn ?? model.inputCost != null ? { costPer1kIn: Number(model.costPer1kIn ?? model.inputCost) } : {}),
        ...(model.costPer1kOut ?? model.outputCost != null ? { costPer1kOut: Number(model.costPer1kOut ?? model.outputCost) } : {}),
        ...(model.quality != null ? { quality: Number(model.quality) } : {}),
        ...(model.label ?? model.title ? { label: model.label ?? model.title } : {}),
      };
    }
  }

  if (comboKey) {
    const container = json[comboKey];
    const entries = Array.isArray(container)
      ? container.map((c, i) => [c.name ?? c.id ?? `combo-${i}`, c])
      : Object.entries(container);
    for (const [id, c] of entries) {
      const combo = /** @type {any} */ (c);
      const rawTargets = combo.targets ?? combo.models ?? combo.routes ?? combo.members ?? combo.chain ?? [];
      const targets = (Array.isArray(rawTargets) ? rawTargets : Object.keys(rawTargets))
        .map((t) => {
          if (typeof t === 'string') return t;
          const name = t.model ?? t.id ?? t.name ?? t.target ?? null;
          if (!name) return null;
          return t.weight != null ? { model: name, weight: Number(t.weight) } : name;
        })
        .filter(Boolean);
      if (!targets.length) {
        warnings.push(`Combo "${id}" has no usable targets; skipped.`);
        continue;
      }
      combos[id] = {
        label: combo.label ?? combo.description ?? id,
        strategy: normaliseStrategy(combo.strategy ?? combo.mode ?? combo.type),
        targets,
      };
    }
  }

  const known = new Set([
    ...PROVIDER_ALIAS_KEYS, ...MODEL_KEYS, ...COMBO_KEYS,
    'version', 'name', 'server', 'settings', 'logging', 'defaults',
    // annotations, not configuration
    '$schema', '_comment', '//',
  ]);
  const unknownKeys = Object.keys(json).filter((k) => !known.has(k));

  return { source, file: path, providers, models, combos, warnings, unknownKeys };
}

/**
 * Compare an import against the live config.
 * @param {any} current
 * @param {ReturnType<typeof readMigrationSource>} imported
 */
export function diffImport(current, imported) {
  const added = { providers: [], models: [], combos: [] };
  const conflicts = [];

  for (const id of Object.keys(imported.providers)) {
    if (current.providers[id]) conflicts.push({ kind: 'provider', id, reason: 'already exists in your config' });
    else added.providers.push(id);
  }
  for (const id of Object.keys(imported.models)) {
    if (current.models[id]) conflicts.push({ kind: 'model', id, reason: 'already exists in your config' });
    else added.models.push(id);
  }
  for (const id of Object.keys(imported.combos)) {
    if (current.combos[id]) conflicts.push({ kind: 'combo', id, reason: 'already exists in your config' });
    else added.combos.push(id);
  }

  // A model whose provider is not coming along cannot work.
  const providerSet = new Set([...Object.keys(current.providers), ...added.providers]);
  const dangling = Object.entries(imported.models)
    .filter(([, m]) => !providerSet.has(/** @type {any} */ (m).provider))
    .map(([id]) => id);

  const comboSet = new Set([...Object.keys(current.models), ...added.models]);
  const danglingCombos = Object.entries(imported.combos)
    .filter(([, c]) =>
      /** @type {any} */ (c).targets.some((t) => !comboSet.has(typeof t === 'string' ? t : t.model)),
    )
    .map(([id]) => id);

  return { added, conflicts, dangling, danglingCombos, total: added.providers.length + added.models.length + added.combos.length };
}

/**
 * Merge chosen entries into a raw config object (returns a new object).
 * @param {any} currentRaw
 * @param {ReturnType<typeof readMigrationSource>} imported
 * @param {{providers?: string[], models?: string[], combos?: string[]}} [select]
 */
export function applyImport(currentRaw, imported, select = {}) {
  const next = structuredClone(currentRaw);
  next.providers = next.providers ?? {};
  next.models = next.models ?? {};
  next.combos = next.combos ?? {};

  const pickProviders = select.providers ?? Object.keys(imported.providers);
  const pickModels = select.models ?? Object.keys(imported.models);
  const pickCombos = select.combos ?? Object.keys(imported.combos);

  for (const id of pickProviders) {
    if (!next.providers[id] && imported.providers[id]) next.providers[id] = imported.providers[id];
  }
  for (const id of pickModels) {
    if (!next.models[id] && imported.models[id]) next.models[id] = imported.models[id];
  }
  for (const id of pickCombos) {
    if (!next.combos[id] && imported.combos[id]) next.combos[id] = imported.combos[id];
  }
  return next;
}

/**
 * Post-migration smoke test: one tiny real turn per imported combo.
 * @param {{chat: Function}} router
 * @param {string[]} combos
 */
export async function smokeTest(router, combos) {
  const results = [];
  for (const combo of combos) {
    const started = Date.now();
    try {
      const res = await router.chat({
        combo,
        body: { messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 16 },
      });
      results.push({
        combo,
        status: res.meta.verified ? 'ok' : 'unverified',
        provider: res.meta.provider,
        modelId: res.meta.modelId,
        ms: Date.now() - started,
        note: res.meta.verified ? null : 'answered by a mock/local provider, so the upstream was not exercised',
      });
    } catch (err) {
      results.push({ combo, status: 'failed', ms: Date.now() - started, note: /** @type {any} */ (err).message });
    }
  }
  return results;
}

function guessSource(path, json) {
  const name = basename(path).toLowerCase();
  const blob = name + ' ' + JSON.stringify(Object.keys(json)).toLowerCase();
  if (/9router/.test(blob)) return '9router';
  if (/omniroute|omni-route/.test(blob)) return 'OmniRoute';
  if (/hubgate|hub-gate/.test(blob)) return 'HubGate';
  if (json.connections) return '9router-style (connections)';
  if (json.channels) return 'OmniRoute-style (channels)';
  if (json.upstreams) return 'HubGate-style (upstreams)';
  return 'unknown router';
}

function normaliseType(t) {
  const v = String(t ?? '').toLowerCase();
  if (/anthropic|claude/.test(v)) return 'anthropic';
  if (/gemini|google|vertex/.test(v)) return 'gemini';
  if (/mock|test/.test(v)) return 'mock';
  return 'openai';
}

function guessType(baseUrl) {
  const u = String(baseUrl ?? '').toLowerCase();
  if (u.includes('anthropic')) return 'anthropic';
  if (u.includes('generativelanguage') || u.includes('googleapis')) return 'gemini';
  return 'openai';
}

function normaliseStrategy(s) {
  const v = String(s ?? 'fallback').toLowerCase();
  if (/weight|split|ab|a-b|ratio/.test(v)) return 'weighted';
  if (/cheap|cost|budget/.test(v)) return 'cheapest';
  if (/latenc|fast/.test(v)) return 'latency';
  return 'fallback';
}
