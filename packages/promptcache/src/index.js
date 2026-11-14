/**
 * @sui/promptcache — native prompt caching (B4.6).
 *
 * Providers cache a *prefix*. Anthropic wants `cache_control` breakpoints,
 * OpenAI caches automatically above a token threshold and takes a
 * `prompt_cache_key` for affinity, and everything else does nothing. So the work
 * here is: find the stable prefix, notice when it goes volatile, and send only
 * the hint the provider actually understands.
 *
 * There is no state on the hot path (I1): `PrefixMemory` is an in-memory LRU of
 * prefix fingerprints, which is the cheapest thing that can answer "have I sent
 * this prefix before?".
 */

import { createHash } from 'node:crypto';

/** Things that make a prefix volatile — each one breaks a provider cache. */
export const DYNAMIC_PATTERNS = [
  { name: 'iso timestamp', re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
  { name: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/ },
  { name: 'clock time', re: /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/i },
  { name: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'request id', re: /\b(req|request|trace|span)[_-]?id\b/i },
  { name: 'random hex', re: /\b[0-9a-f]{16,}\b/i },
  { name: 'counter', re: /\b(nonce|salt|seed)\b/i },
];

/**
 * Split messages into a stable prefix and a volatile tail.
 *
 * The prefix is everything up to (not including) the last user message — that is
 * what a provider can cache. Everything before it that carries a timestamp or an
 * id is reported, because that one string is why the cache never hits.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{prefix: Array<{role: string, content: string}>, tail: Array<{role: string, content: string}>, prefixChars: number, fingerprint: string, volatile: Array<{index: number, name: string}>}}
 */
export function detectPrefix(messages) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const cut = lastUser === -1 ? messages.length : lastUser;
  const prefix = messages.slice(0, cut);
  const tail = messages.slice(cut);

  const prefixText = prefix.map((m) => `${m.role}:${m.content}`).join('\n');
  const volatile = [];
  for (let i = 0; i < prefix.length; i++) {
    for (const pattern of DYNAMIC_PATTERNS) {
      if (pattern.re.test(prefix[i].content ?? '')) volatile.push({ index: i, name: pattern.name });
    }
  }

  return {
    prefix,
    tail,
    prefixChars: prefixText.length,
    fingerprint: createHash('sha256').update(prefixText).digest('hex').slice(0, 16),
    volatile,
  };
}

/**
 * Remember which prefixes have been sent, so "warm" is a fact rather than a hope.
 */
export class PrefixMemory {
  /** @param {{maxEntries?: number, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, {firstSeen: number, lastSeen: number, sends: number}>} */
    this.map = new Map();
    this.warm = 0;
    this.cold = 0;
  }

  /** @param {string} fingerprint */
  touch(fingerprint) {
    const existing = this.map.get(fingerprint);
    if (existing) {
      existing.lastSeen = this.now();
      existing.sends += 1;
      this.map.delete(fingerprint);
      this.map.set(fingerprint, existing);
      this.warm += 1;
      return { warm: true, sends: existing.sends, firstSeen: existing.firstSeen };
    }
    this.map.set(fingerprint, { firstSeen: this.now(), lastSeen: this.now(), sends: 1 });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.cold += 1;
    return { warm: false, sends: 1, firstSeen: this.now() };
  }

  stats() {
    const total = this.warm + this.cold;
    return {
      prefixes: this.map.size,
      warm: this.warm,
      cold: this.cold,
      hitRate: total ? Math.round((this.warm / total) * 1000) / 1000 : 0,
    };
  }
}

/** The minimum prefix a provider will cache. Below this, a hint is noise. */
const MIN_CACHEABLE_CHARS = { anthropic: 1200, openai: 2400, gemini: 4000 };

/**
 * Build the hint a specific provider understands, or say that it has none.
 *
 * @param {string} providerType 'openai' | 'anthropic' | 'gemini' | 'mock'
 * @param {{prefixChars: number, fingerprint: string, warm: boolean}} detected
 * @returns {{supported: boolean, reason: string, anthropic?: {breakpoint: boolean}, openai?: {promptCacheKey: string}}}
 */
export function cacheHints(providerType, detected) {
  const minimum = MIN_CACHEABLE_CHARS[providerType];

  if (providerType === 'anthropic') {
    if (detected.prefixChars < minimum) {
      return { supported: false, reason: `prefix is ${detected.prefixChars} chars; Anthropic caches above ~${minimum}` };
    }
    return { supported: true, reason: 'cache_control breakpoint on the prefix', anthropic: { breakpoint: true } };
  }

  if (providerType === 'openai') {
    if (detected.prefixChars < minimum) {
      return { supported: false, reason: `prefix is ${detected.prefixChars} chars; OpenAI caches above ~${minimum}` };
    }
    return { supported: true, reason: 'prompt_cache_key for routing affinity', openai: { promptCacheKey: detected.fingerprint } };
  }

  if (providerType === 'gemini') {
    return {
      supported: false,
      reason: `Gemini needs an explicit cached-content resource; a per-request hint does nothing (prefix ${detected.prefixChars} chars)`,
    };
  }

  return { supported: false, reason: `provider type "${providerType}" has no prompt-cache hint` };
}

/**
 * One call that does the whole job for a request.
 *
 * @param {{messages: Array<{role: string, content: string}>, providerType: string, memory: PrefixMemory, enabled?: boolean}} input
 */
export function preparePromptCache(input) {
  const enabled = input.enabled !== false;
  if (!enabled) {
    return { hints: { supported: false, reason: 'prompt caching is off' }, detected: null, warm: false };
  }

  const detected = detectPrefix(input.messages);
  const seen = input.memory.touch(detected.fingerprint);
  const hints = cacheHints(input.providerType, detected);

  return {
    detected: {
      prefixChars: detected.prefixChars,
      fingerprint: detected.fingerprint,
      volatile: detected.volatile,
    },
    warm: seen.warm,
    sends: seen.sends,
    hints,
  };
}
