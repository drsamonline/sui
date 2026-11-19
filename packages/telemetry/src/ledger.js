/**
 * The ledger: one append-only record per completed turn.
 *
 * It is what makes "the same task at lower cost" a measurable claim rather than
 * a slogan — every record carries provider, model, combo, arm (for A/B), tokens,
 * cost, latency, time-to-first-token, cache and verification status.
 *
 * Prompt text is never stored unless guardrails.logPrompts is on. What is stored
 * is a salted hash, so the same prompt can be recognised across turns (prompt-free
 * usage view) without the prompt being recoverable.
 */

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** @typedef {{
 *   ts: number, provider: string, model: string, modelId: string, combo: string, arm: string|null,
 *   ok: boolean, error: string|null, promptTokens: number, completionTokens: number,
 *   costUsd: number, latencyMs: number, ttftMs: number|null, cached: boolean,
 *   verified: boolean, promptHash: string, promptChars: number, streamed: boolean
 * }} LedgerRecord */

export class Ledger {
  /**
   * @param {{file?: string|null, maxRecords?: number, salt?: string, hashSecretPath?: string}} [opts]
   */
  constructor(opts = {}) {
    this.file = opts.file ?? null;
    this.maxRecords = opts.maxRecords ?? 5000;
    this.salt = opts.salt ?? 'sui-local-salt';
    /**
     * Per-day totals, kept outside the record window.
     *
     * The window is capped at maxRecords for memory, which is right — but a
     * budget computed from the window silently stops counting once a day passes
     * 5,000 turns, and a budget that stops counting is worse than no budget. This
     * map is O(1) to update and does not depend on the window at all.
     *
     * @type {Map<string, {costUsd: number, turns: number, failed: number, cached: number, byProvider: Map<string, number>}>}
     */
    this.daily = new Map();
    this.maxFileBytes = Number(opts.maxFileBytes ?? 64 * 1024 * 1024);
    this.fileBytes = 0;
    /** @type {LedgerRecord[]} */
    this.records = [];
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      if (existsSync(this.file)) this.#load();
    }
  }

  #load() {
    try {
      const raw = readFileSync(this.file, 'utf8');
      this.fileBytes = Buffer.byteLength(raw);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue; // a torn last line from a hard kill is not worth failing over
        }
        // every row counts towards its day, including rows that fall outside the
        // window: the totals must not depend on how much history is held
        this.#bumpDaily(row);
        this.records.push(row);
      }
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(-this.maxRecords);
        this.#rewrite();
      }
    } catch {
      this.records = [];
    }
  }

  /** @param {any} row */
  #dayKey(row) {
    const d = new Date(row?.ts ?? Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** @param {any} row */
  #bumpDaily(row) {
    const key = this.#dayKey(row);
    let day = this.daily.get(key);
    if (!day) {
      day = { costUsd: 0, turns: 0, failed: 0, cached: 0, byProvider: new Map(), byModel: new Map() };
      this.daily.set(key, day);
      // keep at most three days: yesterday is useful, last week is not
      if (this.daily.size > 3) {
        const oldest = [...this.daily.keys()].sort()[0];
        this.daily.delete(oldest);
      }
    }
    day.costUsd += Number(row.costUsd ?? 0);
    if (row.ok) day.turns += 1;
    else day.failed += 1;
    if (row.cached) day.cached += 1;
    const provider = row.provider ?? 'unknown';
    day.byProvider.set(provider, (day.byProvider.get(provider) ?? 0) + Number(row.costUsd ?? 0));
    if (row.modelId) day.byModel.set(row.modelId, (day.byModel.get(row.modelId) ?? 0) + 1);
  }

  /** The bucket for a given day, or an empty one. */
  #day(now = new Date()) {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return this.daily.get(key) ?? { costUsd: 0, turns: 0, failed: 0, cached: 0, byProvider: new Map() };
  }

  /**
   * Rotate the file when it grows past the cap.
   *
   * Without this a gateway left running appends forever: at 20 rps a three-day
   * soak writes millions of lines, and nothing prunes a file, only an array.
   */
  #rotateIfNeeded(nextBytes) {
    if (!this.file) return;
    this.fileBytes += nextBytes;
    if (this.fileBytes <= this.maxFileBytes) return;
    try {
      renameSync(this.file, `${this.file}.1`);
      // leave an empty file behind: a reader that stats the live path should not
      // find it missing just because a rotation happened between two writes
      writeFileSync(this.file, '');
      this.fileBytes = 0;
    } catch {
      this.fileBytes = 0; // if the rename fails, keep appending rather than stop recording
    }
  }

  #rewrite() {
    if (!this.file) return;
    writeFileSync(this.file, this.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  /** Stable, non-reversible prompt fingerprint. */
  hashPrompt(text) {
    return createHash('sha256').update(this.salt).update(text).digest('hex').slice(0, 16);
  }

  /** @param {Partial<LedgerRecord> & {promptText?: string}} entry */
  record(entry) {
    /** @type {LedgerRecord} */
    const rec = {
      ts: entry.ts ?? Date.now(),
      provider: entry.provider ?? 'unknown',
      model: entry.model ?? 'unknown',
      modelId: entry.modelId ?? 'unknown',
      combo: entry.combo ?? 'unknown',
      arm: entry.arm ?? null,
      ok: entry.ok ?? true,
      error: entry.error ?? null,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      costUsd: entry.costUsd ?? 0,
      latencyMs: entry.latencyMs ?? 0,
      ttftMs: entry.ttftMs ?? null,
      cached: entry.cached ?? false,
      verified: entry.verified ?? false,
      promptHash: entry.promptHash ?? (entry.promptText ? this.hashPrompt(entry.promptText) : ''),
      promptChars: entry.promptChars ?? (entry.promptText ? entry.promptText.length : 0),
      streamed: entry.streamed ?? false,
      // B7.2: what compression saved on this turn, valued at the model's price.
      compressionPreset: entry.compressionPreset ?? null,
      compressionSavedTokens: entry.compressionSavedTokens ?? 0,
      compressionSavedUsd: entry.compressionSavedUsd ?? 0,
      // B6.6: which tenant this turn belongs to. A name, never a key.
      apiKey: entry.apiKey ?? null,
      // B7.1: who asked, and with what. Both are labels the caller supplies;
      // the gateway never infers an identity it was not given.
      user: entry.user ?? null,
      tool: entry.tool ?? null,
      promptCacheWarm: entry.promptCacheWarm ?? false,
    };
    this.records.push(rec);
    this.#bumpDaily(rec);
    if (this.records.length > this.maxRecords) this.records.shift();
    if (this.file) {
      try {
        const line = `${JSON.stringify(rec)}\n`;
        appendFileSync(this.file, line);
        this.#rotateIfNeeded(Buffer.byteLength(line));
      } catch {
        /* ledger is observability, never the request path's failure */
      }
    }
    return rec;
  }

  /**
   * @param {{since?: number, combo?: string}} [opts]
   * @returns {LedgerRecord[]}
   */
  entries(opts = {}) {
    const since = opts.since ?? 0;
    return this.records.filter((r) => r.ts >= since && (!opts.combo || r.combo === opts.combo));
  }

  /** Spend since local midnight, in USD. */
  todaySpendUsd(now = new Date()) {
    // from the daily bucket, not from the record window: a budget that stops
    // counting after 5,000 turns is not a budget
    return round6(this.#day(now).costUsd);
  }

  /** Turns a model has answered today. Used by quota-weighted routing. */
  turnsForModel(modelId, now = new Date()) {
    return this.#day(now).byModel?.get(modelId) ?? 0;
  }

  providerSpendToday(provider, now = new Date()) {
    // same rule as todaySpendUsd: from the day bucket, not the window
    return round6(this.#day(now).byProvider.get(provider) ?? 0);
  }

  /** @deprecated kept for callers that still read the window; use providerSpendToday */
  #providerSpendFromWindow(provider, now = new Date()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return round6(
      this.records
        .filter((r) => r.ts >= start.getTime() && r.provider === provider)
        .reduce((a, r) => a + r.costUsd, 0),
    );
  }

  /**
   * @param {{since?: number}} [opts]
   */
  aggregate(opts = {}) {
    const rows = this.entries(opts);
    // B7.1: attribution uses the same grouping shape as provider/model/combo, so
    // one `bump` does all of it and nothing can drift.
    /** @type {Record<string, any>} */
    const byUser = {};
    /** @type {Record<string, any>} */
    const byTool = {};
    for (const row of rows) {
      bump(byUser, row.user ?? 'unattributed', row);
      bump(byTool, row.tool ?? 'unattributed', row);
    }

    const totals = {
      // A turn is a request that produced an answer. A failed attempt is
      // recorded too (it is how failover is auditable), but it is not a turn.
      turns: rows.filter((r) => r.ok).length,
      // B7.2 Savings Ledger: dollars not spent, and the tokens that bought them.
      savings: { cacheUsd: 0, compressionUsd: 0, totalUsd: 0, tokensSaved: 0, cacheHits: 0, compressedTurns: 0 },
      attempts: rows.length,
      ok: rows.filter((r) => r.ok).length,
      failed: rows.filter((r) => !r.ok).length,
      cached: rows.filter((r) => r.cached).length,
      costUsd: 0,
      savedUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      avgTtftMs: 0,
    };

    /** @type {Record<string, any>} */
    const byProvider = {};
    /** @type {Record<string, any>} */
    const byModel = {};
    /** @type {Record<string, any>} */
    const byCombo = {};
    /** @type {Record<string, any>} */
    const byArm = {};

    for (const r of rows) {
      totals.costUsd += r.costUsd;
      totals.promptTokens += r.promptTokens;
      totals.completionTokens += r.completionTokens;
      if (r.cached) {
        totals.savedUsd += r.costUsd;
        totals.savings.cacheUsd += r.costUsd;
        totals.savings.cacheHits += 1;
      }
      if (r.compressionSavedUsd) {
        totals.savings.compressionUsd += r.compressionSavedUsd;
        totals.savings.tokensSaved += r.compressionSavedTokens ?? 0;
        totals.savings.compressedTurns += 1;
      }

      bump(byProvider, r.provider, r);
      bump(byModel, r.modelId, r);
      bump(byCombo, r.combo, r);
      if (r.arm) bump(byArm, `${r.combo}/${r.arm}`, r);
    }

    // A cache hit answers in microseconds and would drag p50 to zero; it is not
    // a model latency, so it is excluded from latency statistics on purpose.
    const latencies = rows
      .filter((r) => r.ok && !r.cached)
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);
    const ttfts = rows.filter((r) => r.ok && r.ttftMs != null).map((r) => /** @type {number} */ (r.ttftMs));
    totals.costUsd = round6(totals.costUsd);
    totals.savings.cacheUsd = round6(totals.savings.cacheUsd);
    totals.savings.compressionUsd = round6(totals.savings.compressionUsd);
    totals.savings.totalUsd = round6(totals.savings.cacheUsd + totals.savings.compressionUsd);
    // `savedUsd` predates the savings block and is kept for older readers.
    totals.savedUsd = round6(totals.savings.totalUsd);
    totals.avgLatencyMs = latencies.length ? Math.round(mean(latencies)) : 0;
    totals.p50LatencyMs = quantile(latencies, 0.5);
    totals.p95LatencyMs = quantile(latencies, 0.95);
    totals.avgTtftMs = ttfts.length ? Math.round(mean(ttfts)) : 0;

    for (const group of [byProvider, byModel, byCombo, byArm]) {
      for (const v of Object.values(group)) {
        v.costUsd = round6(v.costUsd);
        v.avgLatencyMs = v.latencySamples ? Math.round(v.latencySum / v.latencySamples) : 0;
        delete v.latencySum;
        delete v.latencySamples;
      }
    }

    return {
      since: opts.since ?? 0,
      totals,
      byProvider,
      byModel,
      byCombo,
      byArm,
      // B7.1: who asked and with what, so cost can be charged back
      byUser,
      byTool,
      recent: rows.slice(-50).reverse(),
    };
  }

  /** Prompt-free usage view: which prompt fingerprints recurred, and what they cost. */
  promptUsage(limit = 50) {
    /** @type {Map<string, {promptHash: string, turns: number, chars: number, costUsd: number, combos: Set<string>, models: Set<string>}>} */
    const map = new Map();
    for (const r of this.records) {
      if (!r.promptHash) continue;
      let e = map.get(r.promptHash);
      if (!e) {
        e = { promptHash: r.promptHash, turns: 0, chars: r.promptChars, costUsd: 0, combos: new Set(), models: new Set() };
        map.set(r.promptHash, e);
      }
      e.turns += 1;
      e.costUsd = round6(e.costUsd + r.costUsd);
      e.combos.add(r.combo);
      e.models.add(r.modelId);
    }
    return [...map.values()]
      .map((e) => ({ ...e, combos: [...e.combos], models: [...e.models] }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, limit);
  }

  csv() {
    const header = [
      'timestamp_iso', 'provider', 'model', 'model_id', 'combo', 'arm', 'ok', 'error',
      'prompt_tokens', 'completion_tokens', 'cost_usd', 'latency_ms', 'ttft_ms',
      'cached', 'verified', 'streamed', 'prompt_hash', 'prompt_chars',
      'compression_preset', 'compression_saved_tokens', 'compression_saved_usd',
      'api_key', 'prompt_cache_warm', 'user', 'tool',
    ].join(',');
    const lines = this.records.map((r) =>
      [
        new Date(r.ts).toISOString(), r.provider, r.model, r.modelId, r.combo, r.arm ?? '',
        r.ok, r.error ?? '', r.promptTokens, r.completionTokens, r.costUsd, r.latencyMs,
        r.ttftMs ?? '', r.cached, r.verified, r.streamed, r.promptHash, r.promptChars,
        r.compressionPreset ?? '', r.compressionSavedTokens ?? 0, r.compressionSavedUsd ?? 0,
        r.apiKey ?? '', r.promptCacheWarm ?? false, r.user ?? '', r.tool ?? '',
      ]
        .map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
        .join(','),
    );
    return [header, ...lines].join('\n');
  }
}

function bump(group, key, r) {
  const e = (group[key] ??= { turns: 0, ok: 0, failed: 0, cached: 0, costUsd: 0, tokens: 0, latencySum: 0 });
  e.turns += 1;
  if (r.ok) e.ok += 1;
  else e.failed += 1;
  if (r.cached) e.cached += 1;
  e.costUsd += r.costUsd;
  e.tokens += r.promptTokens + r.completionTokens;
  if (r.ok && !r.cached) {
    e.latencySum += r.latencyMs;
    e.latencySamples = (e.latencySamples ?? 0) + 1;
  }
}

function mean(a) {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export { randomBytes };
