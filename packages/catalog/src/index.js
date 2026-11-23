/**
 * @drsamonline/catalog — the provider catalogue.
 *
 * Rules this package encodes:
 *  - an entry is only routable once it has been probed (verification before use)
 *  - ToS posture is a first-class field: allowed / review / avoid, default review
 *  - dedupe is by pool_key, so the same upstream behind two names collapses
 *  - scoring is a pure function of measured facts, never of vibes
 *
 * Nothing here ships a base URL it has not been given. A catalogue entry with
 * `needs_probe: true` is an identity, not an endpoint.
 */

import { readFileSync } from 'node:fs';

export const TOS_STATES = ['allowed', 'review', 'avoid'];
export const RETENTION_LEVELS = ['none', 'session', 'short', 'long', 'unknown'];
export const CAPABILITIES = [
  'chat',
  'streaming',
  'tools',
  'json_schema',
  'vision',
  'embeddings',
  'rerank',
  'stt',
  'tts',
  'image',
  'video',
  'web_search',
];

/** Scoring weights. Sum to 1; change them only with an ADR. */
export const WEIGHTS = {
  availability: 0.3,
  quota: 0.2,
  latency: 0.15,
  quality: 0.15,
  tos: 0.1,
  privacy: 0.1,
};

/**
 * A stable identity for "this exact upstream pool", used for dedupe.
 * Two catalogue rows pointing at the same host + path + model family are one pool.
 * @param {any} entry
 */
export function poolKey(entry) {
  const base = entry.base_url ? new URL(entry.base_url).host + new URL(entry.base_url).pathname.replace(/\/+$/, '') : `unverified:${entry.provider}`;
  return `${base}|${entry.model_family ?? entry.provider}`;
}

/**
 * @param {any} raw
 * @returns {any}
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('catalogue entry must be an object');
  if (!raw.provider) throw new TypeError('catalogue entry needs a provider name');
  const tos = TOS_STATES.includes(raw.tos) ? raw.tos : 'review';
  const retention = RETENTION_LEVELS.includes(raw.privacy_retention) ? raw.privacy_retention : 'unknown';
  return {
    provider: String(raw.provider),
    label: raw.label ?? String(raw.provider),
    base_url: raw.base_url ?? null,
    docs_url: raw.docs_url ?? null,
    model_family: raw.model_family ?? null,
    auth: raw.auth === 'key' ? 'key' : 'none',
    key_env: raw.key_env ?? null,
    local: Boolean(raw.local),
    tos,
    privacy_retention: retention,
    capabilities: (raw.capabilities ?? ['chat']).filter((c) => CAPABILITIES.includes(c)),
    context_window: raw.context_window ?? null,
    quota: raw.quota ?? null,
    // a published recurring monthly budget, in tokens, and where the number came
    // from. Absent is absent: freeBudget() never invents one.
    monthly_tokens: Number.isFinite(Number(raw.monthly_tokens)) && Number(raw.monthly_tokens) > 0 ? Number(raw.monthly_tokens) : null,
    budget_source: raw.budget_source ?? null,
    needs_probe: raw.base_url ? Boolean(raw.needs_probe) : true,
    verified_at: raw.verified_at ?? null,
    notes: raw.notes ?? null,
  };
}

/** @param {any[]} entries */
export function dedupeEntries(entries) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    const key = poolKey(entry);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...entry, pool_key: key, aliases: [entry.provider] });
      continue;
    }
    // keep the better ToS posture, the more specific retention, and record the alias
    existing.tos = betterTos(existing.tos, entry.tos);
    if (existing.privacy_retention === 'unknown') existing.privacy_retention = entry.privacy_retention;
    if (!existing.aliases.includes(entry.provider)) existing.aliases.push(entry.provider);
    if (!existing.base_url && entry.base_url) existing.base_url = entry.base_url;
    existing.capabilities = [...new Set([...existing.capabilities, ...entry.capabilities])];
  }
  return [...byKey.values()];
}

function betterTos(a, b) {
  const rank = { allowed: 3, review: 2, avoid: 1 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Is this entry allowed to answer an automatic route?
 * @param {any} entry
 */
export function isRoutable(entry) {
  if (!entry || entry.tos === 'avoid') return false;
  if (entry.needs_probe) return false;
  return Boolean(entry.base_url);
}

/**
 * Health score in [0,1] from measured facts.
 * Missing measurements do not score as zero — they score as unknown and the
 * entry stays out of the pool until probed, so a gap cannot look like health.
 *
 * @param {any} entry
 * @param {{probe?: {ok: boolean, latencyMs?: number, checkedAt?: number}, quality?: number, now?: number}} [facts]
 */
export function scoreEntry(entry, facts = {}) {
  const probe = facts.probe ?? null;
  const now = facts.now ?? Date.now();

  const availability = probe ? (probe.ok ? 1 : 0) : 0;
  const quota = entry.quota == null ? 0.5 : Math.max(0, Math.min(1, Number(entry.quota.remaining ?? 1) / Number(entry.quota.limit ?? 1)));
  const latency = probe?.latencyMs == null ? 0.5 : Math.max(0, 1 - Math.min(1, probe.latencyMs / 4000));
  const quality = facts.quality == null ? 0.5 : Math.max(0, Math.min(1, facts.quality / 5));
  const tos = entry.tos === 'allowed' ? 1 : entry.tos === 'review' ? 0.4 : 0;
  const privacy = { none: 1, session: 0.8, short: 0.6, long: 0.2, unknown: 0.4 }[entry.privacy_retention] ?? 0.4;

  const score =
    availability * WEIGHTS.availability +
    quota * WEIGHTS.quota +
    latency * WEIGHTS.latency +
    quality * WEIGHTS.quality +
    tos * WEIGHTS.tos +
    privacy * WEIGHTS.privacy;

  return {
    score: Math.round(score * 1000) / 1000,
    routable: isRoutable(entry) && availability > 0,
    parts: { availability, quota, latency, quality, tos, privacy },
    checkedAt: probe?.checkedAt ?? now,
  };
}

/** Load a seed catalogue from disk. Accepts {entries:[...]} or a bare array. */
/**
 * Merge observed facts over imported ones.
 *
 * `seed.json` holds what a source recorded; `verified.json` holds what this
 * gateway measured. Keeping them apart means a probe can never rewrite
 * provenance, and revoking a route is deleting one row rather than editing a
 * curated file.
 *
 * @param {any[]} entries
 * @param {any[]} observed
 */
/**
 * Read what *this* machine observed, from an overlay file the CLI writes.
 *
 * Two callers need it now — `sui catalog` and the gateway's provider routes — and
 * a second implementation of the same parsing is a second place for the same bug
 * (this repository has shipped that bug more than once). The paths are passed in
 * rather than derived: the caller knows where its Sui home is, and this package
 * does not depend on core to find out.
 *
 * @param {string[]} paths most specific first
 * @returns {any[]} observations, empty when none is readable
 */
export function readVerifiedOverlay(paths = []) {
  for (const path of paths) {
    if (!path) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed.entries) && parsed.entries.length) return parsed.entries;
    } catch {
      // a corrupt or missing overlay must not stop the catalogue loading: the
      // seed is imported fact, the overlay is one machine's observation
    }
  }
  return [];
}

export function applyVerified(entries, observed = []) {
  const byProvider = new Map(observed.map((row) => [row.provider, row]));
  return entries.map((entry) => {
    const seen = byProvider.get(entry.provider);
    if (!seen) return entry;
    return {
      ...entry,
      base_url: seen.base_url ?? entry.base_url,
      probe_model: seen.probe_model ?? entry.probe_model ?? null,
      models: seen.models ?? entry.models ?? [],
      verified_at: seen.verified_at ?? entry.verified_at ?? null,
      // a verified entry is routable: the probe is what makes it so
      needs_probe: seen.verified_at ? false : entry.needs_probe,
      tos: seen.tos ?? entry.tos,
      capabilities: seen.capabilities ? [...new Set([...entry.capabilities, ...seen.capabilities])] : entry.capabilities,
    };
  });
}

export function loadSeed(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
  return dedupeEntries(entries);
}

/**
 * Group a catalogue by routability, for the Weather Map and for `sui doctor`.
 * @param {any[]} entries
 * @param {Record<string, any>} [probes] keyed by pool_key
 */
export function summarise(entries, probes = {}) {
  const rows = entries.map((e) => ({ ...e, health: scoreEntry(e, { probe: probes[e.pool_key] }) }));
  return {
    total: rows.length,
    routable: rows.filter((r) => r.health.routable).length,
    awaiting_probe: rows.filter((r) => r.needs_probe).length,
    tos_avoid: rows.filter((r) => r.tos === 'avoid').length,
    rows,
  };
}

/**
 * Monthly free headroom, computed honestly.
 *
 * The number everyone wants is "how many free tokens per month do I have". The
 * number that can be defended is smaller: only pools that publish a recurring
 * budget, counted once per pool (two names for one upstream are one pool), and
 * kept in two columns — what a probe reached, and what is only a claim.
 *
 * Unverified entries are never summed into the verified total. A headline that
 * mixes them is a marketing number; this one is a measurement, and it says how
 * much of it is missing.
 *
 * @param {Array<any>} entries catalogue entries, each optionally carrying
 *   `monthly_tokens` (a published recurring budget) and `pool_key`
 * @param {Record<string, any>} [probes] keyed by pool_key, as `sui probe --write` records
 * @returns {{verifiedTokens: number, unverifiedTokens: number, verified: Array<any>, unverified: Array<any>, withoutBudget: number, pools: number, note: string}}
 */
export function freeBudget(entries, probes = {}) {
  /** @type {Map<string, any>} */
  const pools = new Map();

  for (const entry of entries) {
    const key = entry.pool_key ?? poolKey(entry);
    const existing = pools.get(key);
    const tokens = Number(entry.monthly_tokens ?? 0);
    // one pool, one budget: a second name for the same upstream does not double it
    if (existing) {
      existing.names.push(entry.provider);
      if (tokens > existing.tokens) existing.tokens = tokens;
      continue;
    }
    pools.set(key, {
      pool_key: key,
      names: [entry.provider],
      tokens: Number.isFinite(tokens) ? tokens : 0,
      tos: entry.tos ?? 'review',
      budget_source: entry.budget_source ?? null,
    });
  }

  const verified = [];
  const unverified = [];
  let withoutBudget = 0;

  for (const pool of pools.values()) {
    if (!pool.tokens) {
      withoutBudget += 1;
      continue;
    }
    const probe = probes[pool.pool_key];
    if (probe?.ok === true) verified.push(pool);
    else unverified.push(pool);
  }

  const sum = (rows) => rows.reduce((a, r) => a + r.tokens, 0);
  const verifiedTokens = sum(verified);
  const unverifiedTokens = sum(unverified);

  const note = verifiedTokens
    ? `${verified.length} pool(s) with a published budget answered a probe.`
    : 'No pool with a published budget has answered a probe here yet, so the verified total is zero. That is a measurement, not a shortfall: run `sui probe --write` on a networked machine.';

  return {
    verifiedTokens,
    unverifiedTokens,
    verified,
    unverified,
    withoutBudget,
    pools: pools.size,
    note,
  };
}

/** 1_620_000 → "1.62M". A token count is read, not calculated. */
export function formatTokens(n) {
  const num = Number(n ?? 0);
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
  return String(num);
}
