/**
 * Per-target circuit breaker.
 *
 * closed -> (failures >= threshold) -> open
 * open   -> (cooldown elapsed)      -> half-open (one trial request allowed)
 * half-open -> success              -> closed
 * half-open -> failure              -> open, cooldown restarts
 *
 * The breaker is the reason a rate-limited provider costs one failed request
 * instead of every request until its quota resets.
 */

const CLOSED = 'closed';
const OPEN = 'open';
const HALF_OPEN = 'half_open';

export class CircuitBreaker {
  /**
   * @param {{failures?: number, cooldownMs?: number, halfOpenSuccesses?: number, now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    this.threshold = opts.failures ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30000;
    this.halfOpenSuccesses = opts.halfOpenSuccesses ?? 1;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, {state: string, failures: number, openedAt: number, successes: number, lastError: string|null}>} */
    this.targets = new Map();
  }

  /** @param {string} key */
  #entry(key) {
    let e = this.targets.get(key);
    if (!e) {
      e = { state: CLOSED, failures: 0, openedAt: 0, successes: 0, lastError: null };
      this.targets.set(key, e);
    }
    return e;
  }

  /** @param {string} key */
  canAttempt(key) {
    const e = this.#entry(key);
    if (e.state === CLOSED) return true;
    if (e.state === OPEN) {
      if (this.now() - e.openedAt >= this.cooldownMs) {
        e.state = HALF_OPEN;
        e.successes = 0;
        return true;
      }
      return false;
    }
    // half-open: allow the trial through
    return true;
  }

  /** @param {string} key */
  recordSuccess(key) {
    const e = this.#entry(key);
    if (e.state === HALF_OPEN) {
      e.successes += 1;
      if (e.successes >= this.halfOpenSuccesses) {
        e.state = CLOSED;
        e.failures = 0;
        e.lastError = null;
      }
      return;
    }
    e.state = CLOSED;
    e.failures = 0;
    e.lastError = null;
  }

  /**
   * @param {string} key
   * @param {string} [reason]
   */
  recordFailure(key, reason) {
    const e = this.#entry(key);
    e.failures += 1;
    e.lastError = reason ?? e.lastError;
    if (e.state === HALF_OPEN || e.failures >= this.threshold) {
      e.state = OPEN;
      e.openedAt = this.now();
      e.successes = 0;
    }
  }

  /** @param {string} key */
  reset(key) {
    this.targets.delete(key);
  }

  resetAll() {
    this.targets.clear();
  }

  /** @param {string} key */
  stateOf(key) {
    const e = this.#entry(key);
    const cooling = e.state === OPEN ? Math.max(0, this.cooldownMs - (this.now() - e.openedAt)) : 0;
    return {
      key,
      state: e.state,
      failures: e.failures,
      lastError: e.lastError,
      retryInMs: cooling,
    };
  }

  snapshot() {
    return [...this.targets.keys()].map((k) => this.stateOf(k));
  }
}
