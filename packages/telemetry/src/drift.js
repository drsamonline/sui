/**
 * @sui/telemetry/drift — B3.7, detecting that a target changed behaviour.
 *
 * Two standard detectors, because they answer different questions:
 *
 *   EWMA    "where is it now?" — a smoothed level, compared to a baseline.
 *           Fast to react, but a single bad minute can trigger it.
 *   CUSUM   "how long has it been off?" — accumulates small deviations in both
 *           directions, so a slow 5% slide is caught even though no single
 *           sample looks wrong. This is the one a breaker cannot see.
 *
 * Both are deterministic and cheap: a few multiplications per sample. Neither
 * needs a model, a window buffer, or a second request.
 */

/** A one-sided CUSUM pair plus an EWMA, per series. */
export class DriftMonitor {
  /**
   * @param {{alpha?: number, slack?: number, threshold?: number, baselineSamples?: number}} [opts]
   */
  constructor(opts = {}) {
    this.alpha = Number(opts.alpha ?? 0.2);
    // slack is in standard deviations of the baseline: noise inside this band is
    // not drift, it is variance, and treating it as drift is how alerting dies
    this.slack = Number(opts.slack ?? 0.5);
    this.threshold = Number(opts.threshold ?? 5);
    this.baselineSamples = Number(opts.baselineSamples ?? 10);
    // A perfect baseline has a standard deviation of zero, which makes every
    // wobble infinitely significant. Floor it at a small fraction of the level.
    this.minSdRatio = Number(opts.minSdRatio ?? 0.02);

    /** @type {Map<string, any>} */
    this.series = new Map();
  }

  #state(key) {
    let state = this.series.get(key);
    if (!state) {
      state = {
        ewma: null,
        sum: 0,
        sumSq: 0,
        count: 0,
        baselineMean: null,
        baselineSd: null,
        cusumUp: 0,
        cusumDown: 0,
        alarm: null,
        latched: false,
        samples: 0,
      };
      this.series.set(key, state);
    }
    return state;
  }

  /**
   * @param {string} key
   * @param {number} value
   */
  record(key, value) {
    const state = this.#state(key);
    const x = Number(value);
    if (!Number.isFinite(x)) return this.snapshot(key);

    state.samples += 1;
    state.ewma = state.ewma === null ? x : this.alpha * x + (1 - this.alpha) * state.ewma;

    // Build the baseline from the first N samples, then freeze it. A baseline that
    // keeps moving with the drift can never detect the drift.
    if (state.count < this.baselineSamples) {
      state.count += 1;
      state.sum += x;
      state.sumSq += x * x;
      if (state.count === this.baselineSamples) {
        state.baselineMean = state.sum / state.count;
        const variance = Math.max(0, state.sumSq / state.count - state.baselineMean ** 2);
        const sd = Math.sqrt(variance);
        state.baselineSd = Math.max(sd, Math.abs(state.baselineMean) * this.minSdRatio, 1e-6);
      }
      return this.snapshot(key);
    }

    const slack = this.slack * state.baselineSd;
    const deviation = x - state.baselineMean;
    state.cusumUp = Math.max(0, state.cusumUp + deviation - slack);
    state.cusumDown = Math.max(0, state.cusumDown - deviation - slack);

    if (state.cusumUp > this.threshold || state.cusumDown > this.threshold) {
      const direction = state.cusumUp > this.threshold ? 'up' : 'down';
      const cusum = direction === 'up' ? state.cusumUp : state.cusumDown;
      state.alarm = { direction, cusum: Math.round(cusum * 100) / 100, at: state.samples };
      // A signalled CUSUM restarts, or it grows without bound and stops meaning
      // anything. The alarm stays latched until the level itself comes back.
      state.cusumUp = 0;
      state.cusumDown = 0;
      state.latched = true;
    } else if (state.latched) {
      // Recovered when the smoothed level is back within two standard deviations
      // of the baseline, not merely when one sample looks normal.
      const back = Math.abs(state.ewma - state.baselineMean) <= 2 * state.baselineSd;
      if (back) {
        state.latched = false;
        state.alarm = null;
      }
    }

    return this.snapshot(key);
  }

  /** @param {string} key */
  snapshot(key) {
    const state = this.series.get(key);
    if (!state) return null;
    return {
      key,
      samples: state.samples,
      ewma: state.ewma === null ? null : Math.round(state.ewma * 1000) / 1000,
      baseline: state.baselineMean === null ? null : Math.round(state.baselineMean * 1000) / 1000,
      sd: state.baselineSd === null ? null : Math.round(state.baselineSd * 1000) / 1000,
      cusumUp: Math.round(state.cusumUp * 100) / 100,
      cusumDown: Math.round(state.cusumDown * 100) / 100,
      alarm: state.alarm,
      latched: state.latched,
    };
  }

  /** Every series that is currently alarming, worst first. */
  alarms() {
    return [...this.series.keys()]
      .map((key) => this.snapshot(key))
      .filter((s) => s?.alarm)
      .sort((a, b) => (b?.alarm?.cusum ?? 0) - (a?.alarm?.cusum ?? 0));
  }

  /** Forget a series — used when a target is edited or the baseline is wrong. */
  reset(key) {
    if (key) this.series.delete(key);
    else this.series.clear();
  }
}

/**
 * Read a ledger and report drift per model on latency and failure rate.
 * Called by the worker, never on the request path.
 *
 * @param {{records: Array<any>, monitor?: DriftMonitor, since?: number, minSamples?: number}} input
 */
export function driftFromLedger(input) {
  const monitor = input.monitor ?? new DriftMonitor();
  const since = input.since ?? 0;
  const rows = input.records.filter((r) => (r.ts ?? 0) >= since);

  /** @type {Map<string, {latency: number[], failures: number[]}>} */
  const byModel = new Map();
  for (const row of rows) {
    const bucket = byModel.get(row.modelId) ?? { latency: [], failures: [] };
    if (row.ok && Number.isFinite(row.latencyMs)) bucket.latency.push(row.latencyMs);
    bucket.failures.push(row.ok ? 0 : 1);
    byModel.set(row.modelId, bucket);
  }

  const minSamples = Number(input.minSamples ?? 10);
  for (const [modelId, bucket] of byModel) {
    if (bucket.latency.length >= minSamples) {
      for (const value of bucket.latency) monitor.record(`${modelId}:latency`, value);
    }
    if (bucket.failures.length >= minSamples) {
      for (const value of bucket.failures) monitor.record(`${modelId}:failures`, value);
    }
  }

  return { monitor, alarms: monitor.alarms() };
}
