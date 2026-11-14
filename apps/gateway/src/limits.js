/**
 * Per-key limits (B6.6).
 *
 * A key is a tenant. A tenant gets a rate, a spend cap and its own guardrails,
 * and none of those may be bypassed by calling a different combo.
 *
 * The limiter is a token bucket in memory: cheap, honest about being per-process,
 * and enough for a gateway that runs as one process. A shared limiter needs a
 * shared store, which is a Phase 9 problem.
 */

/**
 * @param {{now?: () => number}} [opts]
 */
export class RateLimiter {
  constructor(opts = {}) {
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, {tokens: number, last: number, limited: number}>} */
    this.buckets = new Map();
  }

  /**
   * @param {string} keyId
   * @param {{rpm?: number, burst?: number}} limit
   * @returns {{ok: boolean, remaining: number, retryAfterMs: number, limit: number}}
   */
  check(keyId, limit = {}) {
    const rpm = Number(limit.rpm ?? 0);
    if (!rpm || rpm <= 0) return { ok: true, remaining: Infinity, retryAfterMs: 0, limit: 0 };

    const capacity = Math.max(1, Number(limit.burst ?? Math.ceil(rpm / 10)));
    const refillPerMs = rpm / 60000;
    const now = this.now();

    let bucket = this.buckets.get(keyId);
    if (!bucket) {
      bucket = { tokens: capacity, last: now, limited: 0 };
      this.buckets.set(keyId, bucket);
    }

    // refill, capped at the bucket size
    const elapsed = Math.max(0, now - bucket.last);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.last = now;

    if (bucket.tokens < 1) {
      bucket.limited += 1;
      const retryAfterMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
      return { ok: false, remaining: 0, retryAfterMs, limit: rpm };
    }

    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0, limit: rpm };
  }

  snapshot() {
    return [...this.buckets.entries()].map(([id, b]) => ({ key: id, tokens: Math.floor(b.tokens), limited: b.limited }));
  }
}

/**
 * What has this key spent today?
 * @param {{entries: (opts?: any) => any[]}} ledger
 * @param {string} keyName
 */
export function keySpendToday(ledger, keyName) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = ledger.entries({ since: start.getTime() }).filter((r) => r.apiKey === keyName);
  return {
    spentUsd: Math.round(rows.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 1e6) / 1e6,
    turns: rows.filter((r) => r.ok).length,
  };
}

/**
 * @param {{keyMeta: any, ledger: any}} input
 * @returns {{ok: boolean, spentUsd: number, capUsd: number|null, message: string|null}}
 */
export function checkKeyBudget(input) {
  const cap = input.keyMeta?.dailyUsd;
  if (cap == null) return { ok: true, spentUsd: 0, capUsd: null, message: null };

  const { spentUsd } = keySpendToday(input.ledger, input.keyMeta.name ?? 'unnamed');
  if (spentUsd >= Number(cap)) {
    return {
      ok: false,
      spentUsd,
      capUsd: Number(cap),
      message: `This API key has spent $${spentUsd.toFixed(4)} of its $${Number(cap).toFixed(2)} daily cap. It resets at local midnight, or raise dailyUsd on the key.`,
    };
  }
  return { ok: true, spentUsd, capUsd: Number(cap), message: null };
}
