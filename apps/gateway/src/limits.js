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

/**
 * Adaptive admission.
 *
 * A gateway that answers 503 the moment it is busy turns a two-second queue into
 * a failed request and a retry storm. This holds the request instead: up to
 * `maxConcurrent` are served at once, up to `queueMax` wait for a slot, and a
 * request that would wait longer than `maxWaitMs` is refused with the number of
 * seconds to come back in.
 *
 * The alternative — an unbounded queue — trades a visible failure for an invisible
 * one: every caller times out at once, and the gateway looks slow rather than
 * busy.
 */
export class Admission {
  /**
   * @param {{maxConcurrent?: number, queueMax?: number, maxWaitMs?: number, now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    this.maxConcurrent = Math.max(1, Number(opts.maxConcurrent ?? 64));
    this.queueMax = Math.max(0, Number(opts.queueMax ?? 256));
    this.maxWaitMs = Math.max(0, Number(opts.maxWaitMs ?? 5000));
    this.now = opts.now ?? Date.now;

    this.active = 0;
    /** @type {Array<{resolve: () => void, reject: (e: any) => void, timer: any, enqueuedAt: number}>} */
    this.queue = [];
    this.stats = { served: 0, queued: 0, rejected: 0, longestWaitMs: 0 };
  }

  /**
   * Wait for a slot. Resolves with a release function, or rejects with a refusal
   * that carries the wait it would have needed.
   *
   * @returns {Promise<() => void>}
   */
  async acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      this.stats.served += 1;
      return this.#releaseOnce();
    }

    if (this.queue.length >= this.queueMax) {
      this.stats.rejected += 1;
      const err = new Error(
        `This gateway is at capacity: ${this.active} requests in flight and ${this.queue.length} waiting. Try again in ${Math.max(1, Math.ceil(this.maxWaitMs / 1000))}s.`,
      );
      err.code = 'overloaded';
      err.status = 503;
      err.retryAfterMs = this.maxWaitMs;
      throw err;
    }

    this.stats.queued += 1;
    const enqueuedAt = this.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.queue.findIndex((q) => q.timer === timer);
        if (index >= 0) this.queue.splice(index, 1);
        this.stats.rejected += 1;
        const waited = this.now() - enqueuedAt;
        const err = new Error(
          `This gateway is at capacity: waited ${Math.round(waited / 100) / 10}s for a slot. Try again in a moment.`,
        );
        err.code = 'overloaded';
        err.status = 503;
        err.retryAfterMs = Math.max(1000, this.maxWaitMs - waited);
        reject(err);
      }, this.maxWaitMs);
      // Deliberately NOT unref'd. An unref'd timer lets the event loop exit while
      // a request is still queued, so the waiter neither resolves nor rejects —
      // a hang instead of a timeout. A queued request holds the loop for at most
      // maxWaitMs, which is the point.
      this.queue.push({ resolve, reject, timer, enqueuedAt });
    }).then((release) => release);
  }

  #releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#drain();
    };
  }

  #drain() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      const waited = this.now() - next.enqueuedAt;
      this.stats.longestWaitMs = Math.max(this.stats.longestWaitMs, waited);
      this.stats.served += 1;
      // the slot passes straight to the waiter; active stays the same
      next.resolve(this.#releaseOnce());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  snapshot() {
    return {
      maxConcurrent: this.maxConcurrent,
      queueMax: this.queueMax,
      maxWaitMs: this.maxWaitMs,
      active: this.active,
      waiting: this.queue.length,
      ...this.stats,
    };
  }
}
