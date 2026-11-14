/**
 * Response cache — two tiers.
 *
 *   exact     a hash of the whole request (combo, messages, sampling params)
 *   semantic  tf-idf similarity between prompts, via the vendored ml-kit
 *
 * The semantic tier is **off by default** and that is a privacy decision, not a
 * performance one: to compare prompts it has to keep recent prompt text in
 * memory. Nothing is written to disk, and turning it on is an explicit choice
 * (`server.cache.semantic.enabled`).
 *
 * A cache hit consumes no provider quota, which is the whole point: it is the
 * cheapest possible route.
 */

import { createHash } from 'node:crypto';
import { loadKit } from '@sui/kits';

export class ResponseCache {
  /**
   * @param {{
   *   ttlMs?: number, maxEntries?: number, enabled?: boolean, now?: () => number,
   *   semantic?: {enabled?: boolean, threshold?: number}
   * }} [opts]
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 900000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? Date.now;
    this.semanticEnabled = Boolean(opts.semantic?.enabled);
    this.semanticThreshold = Number(opts.semantic?.threshold ?? 0.98);

    /** @type {Map<string, {value: any, expiresAt: number, promptText: string|null}>} */
    this.map = new Map();
    this.hits = 0;
    this.semanticHits = 0;
    this.misses = 0;

    /** @type {{index: any, keys: string[]}|null} */
    this._index = null;
    this._indexDirty = true;
  }

  /** @param {any} request */
  static key(request) {
    const basis = JSON.stringify({
      combo: request.combo ?? null,
      messages: request.messages,
      temperature: request.temperature ?? null,
      max_tokens: request.max_tokens ?? null,
      top_p: request.top_p ?? null,
      stop: request.stop ?? null,
      model: request.model ?? null,
    });
    return createHash('sha256').update(basis).digest('hex').slice(0, 32);
  }

  /**
   * @param {string} key
   * @param {string} [promptText] the query, for the semantic tier
   * @returns {{value: any, kind: 'exact'|'semantic'}|null}
   */
  get(key, promptText) {
    if (!this.enabled) return null;

    const hit = this.map.get(key);
    if (hit) {
      if (hit.expiresAt <= this.now()) {
        this.map.delete(key);
        this._indexDirty = true;
      } else {
        this.map.delete(key);
        this.map.set(key, hit); // refresh LRU position
        this.hits += 1;
        return { value: hit.value, kind: 'exact' };
      }
    }

    const semantic = this.#semanticLookup(promptText);
    if (semantic) {
      this.semanticHits += 1;
      this.hits += 1;
      return semantic;
    }

    this.misses += 1;
    return null;
  }

  /**
   * @param {string} key
   * @param {any} value
   * @param {{promptText?: string}} [meta]
   */
  set(key, value, meta = {}) {
    if (!this.enabled) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
        this._indexDirty = true;
      }
    }
    this.map.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
      promptText: this.semanticEnabled ? meta.promptText ?? null : null,
    });
    this._indexDirty = true;
  }

  /**
   * @param {string|undefined} query
   * @returns {{value: any, kind: 'semantic'}|null}
   */
  #semanticLookup(query) {
    if (!this.semanticEnabled || !query) return null;
    const index = this.#ensureIndex();
    if (!index || !index.keys.length) return null;

    const MLKit = loadKit('ml-kit');
    const results = MLKit.search(index.index, query, 3);
    for (const r of results) {
      if (r.score < this.semanticThreshold) continue;
      const key = index.keys[r.i];
      if (!key) continue;
      const entry = this.map.get(key);
      if (!entry || entry.expiresAt <= this.now()) continue;
      return { value: entry.value, kind: 'semantic' };
    }
    return null;
  }

  #ensureIndex() {
    if (!this._indexDirty && this._index) return this._index;
    const keys = [];
    const docs = [];
    for (const [key, entry] of this.map.entries()) {
      if (!entry.promptText) continue;
      if (entry.expiresAt <= this.now()) continue;
      keys.push(key);
      docs.push(entry.promptText);
    }
    if (!docs.length) {
      this._index = { index: null, keys: [] };
      this._indexDirty = false;
      return this._index;
    }
    const MLKit = loadKit('ml-kit');
    this._index = { index: MLKit.tfidf(docs), keys };
    this._indexDirty = false;
    return this._index;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      enabled: this.enabled,
      entries: this.map.size,
      hits: this.hits,
      semanticHits: this.semanticHits,
      misses: this.misses,
      hitRate: total ? Math.round((this.hits / total) * 100) / 100 : 0,
      semantic: { enabled: this.semanticEnabled, threshold: this.semanticThreshold },
    };
  }

  clear() {
    this.map.clear();
    this._index = null;
    this._indexDirty = true;
  }
}
