/**
 * Response cache. Small, TTL-based, in-process.
 *
 * It exists for two reasons: it cuts spend on repeated prompts (a coding agent
 * re-reading the same file), and it gives every response an honest "cached?"
 * answer in its provenance chip.
 */

import { createHash } from 'node:crypto';

export class ResponseCache {
  /** @param {{ttlMs?: number, maxEntries?: number, enabled?: boolean, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 900000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, {value: any, expiresAt: number}>} */
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
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

  /** @param {string} key */
  get(key) {
    if (!this.enabled) return null;
    const hit = this.map.get(key);
    if (!hit) {
      this.misses += 1;
      return null;
    }
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key);
      this.misses += 1;
      return null;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits += 1;
    return hit.value;
  }

  /** @param {string} key @param {any} value */
  set(key, value) {
    if (!this.enabled) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      enabled: this.enabled,
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Math.round((this.hits / total) * 100) / 100 : 0,
    };
  }

  clear() {
    this.map.clear();
  }
}
