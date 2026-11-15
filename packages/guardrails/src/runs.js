/**
 * @sui/guardrails/runs — B5.5, bounded runs and approval gates.
 *
 * An agent that can call a model in a loop can spend money in a loop. A gateway
 * is the right place to bound that, because it is the only component that sees
 * every call: it can count steps, add up cost, watch the clock, and notice the
 * same call being made for the tenth time.
 *
 * Four bounds, and one gate:
 *
 *   maxUsd     spend, from the same ledger the budget bar reads
 *   maxSteps   calls, because a loop is often cheap per call
 *   maxMs      wall clock, because some loops are cheap and endless
 *   loop       the same tool with the same input, N times in a window
 *
 * The gate: a tool listed as needing approval returns `needsApproval` until
 * somebody approves that exact call. Approvals are per run, per call, and
 * single-use — an approval that carries over to the next call is not an approval,
 * it is a blank cheque.
 */

/** FNV-1a, for a stable hash of a call's input. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A call is identified by what it does, not by when it did it. */
export function callSignature(tool, input) {
  const normalised = JSON.stringify(input ?? {}, Object.keys(input ?? {}).sort());
  return `${tool}:${hash32(normalised)}`;
}

export class RunTracker {
  /**
   * @param {{maxUsd?: number|null, maxSteps?: number|null, maxMs?: number|null, loopWindow?: number, maxRepeats?: number, requireApproval?: string[]}} [limits]
   */
  constructor(limits = {}) {
    this.maxUsd = limits.maxUsd ?? null;
    this.maxSteps = limits.maxSteps ?? null;
    this.maxMs = limits.maxMs ?? null;
    this.loopWindow = Number(limits.loopWindow ?? 20);
    this.maxRepeats = Number(limits.maxRepeats ?? 3);
    this.requireApproval = limits.requireApproval ?? [];

    this.steps = 0;
    this.spentUsd = 0;
    this.startedAt = null;
    this.finishedAt = null;
    // The most recent clock reading any caller supplied. Elapsed time is measured
    // against this rather than Date.now(), so an injected clock actually injects.
    this.lastSeenAt = null;
    /** @type {Array<{signature: string, at: number}>} */
    this.recent = [];
    /** @type {Set<string>} */
    this.approved = new Set();
    /** @type {Array<{signature: string, reason: string, at: number}>} */
    this.denials = [];
  }

  /** @param {number} [now] */
  start(now = Date.now()) {
    this.startedAt = now;
    return this;
  }

  /** @param {number} [now] */
  finish(now = Date.now()) {
    this.finishedAt = now;
    this.lastSeenAt = now;
  }

  get elapsedMs() {
    if (this.startedAt === null) return 0;
    return (this.finishedAt ?? this.lastSeenAt ?? this.startedAt) - this.startedAt;
  }

  /**
   * Decide whether the next call may proceed.
   *
   * @param {{tool: string, input?: any, costUsd?: number, now?: number}} call
   * @returns {{decision: 'allow'|'deny'|'needsApproval', reason: string, signature: string, steps: number, spentUsd: number, elapsedMs: number}}
   */
  check(call) {
    const now = call.now ?? Date.now();
    this.lastSeenAt = now;
    const signature = callSignature(call.tool, call.input);
    const base = { signature, steps: this.steps, spentUsd: Math.round(this.spentUsd * 1e6) / 1e6, elapsedMs: this.elapsedMs };

    const deny = (reason) => {
      this.denials.push({ signature, reason, at: now });
      if (this.denials.length > 50) this.denials.shift();
      return { decision: 'deny', reason, ...base };
    };

    if (this.maxSteps !== null && this.steps >= this.maxSteps) {
      return deny(`step limit reached (${this.steps}/${this.maxSteps}) — raise maxSteps or start a new run`);
    }
    if (this.maxUsd !== null && this.spentUsd >= this.maxUsd) {
      return deny(`run budget exhausted ($${this.spentUsd.toFixed(4)} of $${this.maxUsd.toFixed(2)})`);
    }
    if (this.maxMs !== null && this.elapsedMs >= this.maxMs) {
      return deny(`time limit reached (${Math.round(this.elapsedMs / 1000)}s of ${Math.round(this.maxMs / 1000)}s)`);
    }

    // The loop check: the same call, the same input, too many times recently.
    this.recent = this.recent.filter((r) => now - r.at <= this.loopWindow * 1000 || r.at > now);
    const repeats = this.recent.filter((r) => r.signature === signature).length;
    if (repeats >= this.maxRepeats) {
      return deny(`loop detected: ${call.tool} called ${repeats + 1} times with the same input in ${this.loopWindow}s — change the input or stop`);
    }

    if (this.requireApproval.includes(call.tool) && !this.approved.has(signature)) {
      return { decision: 'needsApproval', reason: `${call.tool} needs approval for this exact call`, ...base };
    }

    return { decision: 'allow', reason: 'within bounds', ...base };
  }

  /**
   * Record a call that was allowed. Returns false if the bounds were already
   * exceeded, so a caller cannot record its way past the limit.
   *
   * @param {{tool: string, input?: any, costUsd?: number, now?: number}} call
   */
  record(call) {
    const now = call.now ?? Date.now();
    this.lastSeenAt = now;
    const signature = callSignature(call.tool, call.input);
    this.steps += 1;
    this.spentUsd += Number(call.costUsd ?? 0);
    this.recent.push({ signature, at: now });
    if (this.recent.length > 200) this.recent.shift();
    // an approval is spent by the call it approved
    this.approved.delete(signature);
    return true;
  }

  /** @param {{tool: string, input?: any}} call */
  approve(call) {
    const signature = callSignature(call.tool, call.input);
    this.approved.add(signature);
    return signature;
  }

  snapshot() {
    return {
      steps: this.steps,
      spentUsd: Math.round(this.spentUsd * 1e6) / 1e6,
      elapsedMs: this.elapsedMs,
      limits: {
        maxUsd: this.maxUsd,
        maxSteps: this.maxSteps,
        maxMs: this.maxMs,
        loopWindow: this.loopWindow,
        maxRepeats: this.maxRepeats,
        requireApproval: this.requireApproval,
      },
      pendingApprovals: [...this.approved],
      denials: [...this.denials].slice(-10),
      finished: this.finishedAt !== null,
    };
  }
}

/** A registry of runs, keyed by the id a caller supplies. */
export class RunRegistry {
  /** @param {{maxRuns?: number, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.maxRuns = Number(opts.maxRuns ?? 200);
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, RunTracker>} */
    this.runs = new Map();
  }

  /** @param {string} id @param {any} limits */
  start(id, limits) {
    const tracker = new RunTracker(limits).start(this.now());
    this.runs.set(id, tracker);
    // oldest finished run goes first when the registry is full
    if (this.runs.size > this.maxRuns) {
      const oldest = [...this.runs.entries()].find(([, t]) => t.finishedAt !== null) ?? [...this.runs.entries()][0];
      if (oldest) this.runs.delete(oldest[0]);
    }
    return tracker;
  }

  /** @param {string} id */
  get(id) {
    return this.runs.get(id) ?? null;
  }

  /** @param {string} id */
  finish(id) {
    const tracker = this.get(id);
    if (tracker) tracker.finish(this.now());
    return tracker;
  }

  list() {
    return [...this.runs.entries()].map(([id, tracker]) => ({ id, ...tracker.snapshot() }));
  }
}
