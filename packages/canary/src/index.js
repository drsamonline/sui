/**
 * @sui/canary — canary rollout with SLO-tied rollback (B9.2).
 *
 * A canary is a percentage of traffic sent to a candidate instead of the baseline,
 * watched against three numbers: success rate, p95 latency, and a minimum sample
 * size before any judgement is allowed.
 *
 * Two rules that make the difference between a useful canary and a coin flip:
 *
 *   1. **No verdict on a handful of requests.** Until `minSamples` have been
 *      observed, the canary neither promotes nor rolls back.
 *   2. **An outage is not a regression.** If the provider is resting, both arms
 *      fail, and rolling the candidate back would blame it for someone else's
 *      downtime. Those observations are counted separately and excluded.
 */

export const STATES = ['running', 'promoted', 'rolled_back'];

const DEFAULT_SLO = {
  minSuccessRate: 0.9,
  maxP95Ms: 8000,
  minSamples: 20,
};

/**
 * @param {{
 *   id?: string, baseline: string, candidate: string, percent?: number,
 *   slo?: Partial<typeof DEFAULT_SLO>, now?: () => number, random?: () => number
 * }} opts
 */
export function createCanary(opts) {
  if (!opts?.baseline || !opts?.candidate) {
    throw new Error('A canary needs a baseline and a candidate.');
  }
  if (opts.baseline === opts.candidate) {
    throw new Error('A canary cannot compare a combo with itself.');
  }

  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const slo = { ...DEFAULT_SLO, ...(opts.slo ?? {}) };
  const percent = Math.max(0, Math.min(100, Number(opts.percent ?? 10)));

  /** @type {{ok: number, failed: number, latencies: number[], excluded: number}} */
  const candidateStats = { ok: 0, failed: 0, latencies: [], excluded: 0 };
  /** @type {Array<{at: number, event: string, detail: string}>} */
  const events = [];

  let state = 'running';

  const stats = () => {
    const samples = candidateStats.ok + candidateStats.failed;
    const sorted = [...candidateStats.latencies].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : 0;
    return {
      samples,
      successRate: samples ? Math.round((candidateStats.ok / samples) * 1000) / 1000 : null,
      p95Ms: p95,
      excludedOutages: candidateStats.excluded,
    };
  };

  const record = (event, detail) => events.push({ at: now(), event, detail });

  return {
    id: opts.id ?? `${opts.candidate}-canary`,
    baseline: opts.baseline,
    candidate: opts.candidate,
    percent,
    slo,

    get state() {
      return state;
    },

    /** Which arm should answer this request? */
    pick() {
      if (state !== 'running') return { arm: 'baseline', reason: `canary is ${state}` };
      const candidate = random() * 100 < percent;
      return {
        arm: candidate ? 'candidate' : 'baseline',
        combo: candidate ? opts.candidate : opts.baseline,
        reason: candidate ? `${percent}% of traffic goes to the candidate` : 'baseline traffic',
      };
    },

    /**
     * Fold in one observation from the candidate arm.
     * @param {{ok: boolean, latencyMs?: number, outage?: boolean}} observation
     * @returns {{state: string, event: string|null, detail: string}}
     */
    observe(observation) {
      if (state !== 'running') return { state, event: null, detail: 'canary is finished' };

      // An outage is not evidence about the candidate: it is evidence about the
      // provider, and it hits both arms equally.
      if (observation.outage) {
        candidateStats.excluded += 1;
        return { state, event: null, detail: 'provider outage — observation excluded from the verdict' };
      }

      if (observation.ok) {
        candidateStats.ok += 1;
        if (Number.isFinite(observation.latencyMs)) candidateStats.latencies.push(Number(observation.latencyMs));
      } else {
        candidateStats.failed += 1;
      }

      const s = stats();
      if (s.samples < slo.minSamples) {
        return { state, event: null, detail: `${s.samples}/${slo.minSamples} samples — no verdict yet` };
      }

      if (s.successRate < slo.minSuccessRate) {
        state = 'rolled_back';
        const detail = `success rate ${Math.round(s.successRate * 100)}% fell below ${Math.round(slo.minSuccessRate * 100)}% over ${s.samples} samples`;
        record('rolled_back', detail);
        return { state, event: 'rolled_back', detail };
      }

      if (s.p95Ms > slo.maxP95Ms) {
        state = 'rolled_back';
        const detail = `p95 ${s.p95Ms}ms exceeded ${slo.maxP95Ms}ms over ${s.samples} samples`;
        record('rolled_back', detail);
        return { state, event: 'rolled_back', detail };
      }

      // Sample floor met and both SLOs held: the candidate has earned the traffic.
      state = 'promoted';
      const detail = `success ${Math.round(s.successRate * 100)}%, p95 ${s.p95Ms}ms over ${s.samples} samples`;
      record('promoted', detail);
      return { state, event: 'promoted', detail };
    },

    /** Roll back by hand — the operator always outranks the SLO. */
    rollback(reason = 'rolled back by an operator') {
      if (state !== 'running') return { state, event: null, detail: 'canary is finished' };
      state = 'rolled_back';
      record('rolled_back', reason);
      return { state, event: 'rolled_back', detail: reason };
    },

    snapshot() {
      return {
        id: opts.id ?? `${opts.candidate}-canary`,
        baseline: opts.baseline,
        candidate: opts.candidate,
        percent,
        slo,
        state,
        stats: stats(),
        events: [...events].slice(-20),
      };
    },
  };
}
