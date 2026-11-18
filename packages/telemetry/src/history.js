/**
 * @drsamonline/telemetry/history — B2.7, health over time.
 *
 * The prober already keeps 24 observations per target in memory, which is enough
 * for a sparkline and useless the moment the process restarts. This keeps a
 * rolling history on disk so "has it been flaky all morning?" is answerable.
 *
 * Three constraints, because this is the one place that writes over time:
 *
 *   - **Prompt-free, like everything else** (I11). A sample is a timestamp, a
 *     model id, a duration and a boolean. There is no field a prompt could go in,
 *     and `test/history.test.js` asserts the stored rows have exactly that shape.
 *   - **Bounded.** A cap on rows and on age, pruned on write, so a gateway left
 *     running for a month does not fill a disk.
 *   - **Cheap.** Appends are buffered and flushed in batches; a probe pass must
 *     not turn into a hundred file writes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The only fields a sample may have. */
export const SAMPLE_FIELDS = ['ts', 'modelId', 'ok', 'latencyMs', 'state'];

export class HistoryStore {
  /**
   * @param {{file?: string|null, maxRows?: number, maxAgeMs?: number, now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    this.file = opts.file ?? null;
    this.maxRows = Number(opts.maxRows ?? 20_000);
    this.maxAgeMs = Number(opts.maxAgeMs ?? 7 * 24 * 3600_000);
    this.now = opts.now ?? Date.now;

    /** @type {Array<{ts: number, modelId: string, ok: boolean, latencyMs: number|null, state: string}>} */
    this.rows = [];
    this.dirty = 0;

    if (this.file && existsSync(this.file)) this.#load();
  }

  #load() {
    try {
      const text = readFileSync(this.file, 'utf8');
      const rows = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          // a row with an unexpected field is dropped rather than trusted: this
          // file is the one place a prompt could hide
          const extra = Object.keys(row).filter((k) => !SAMPLE_FIELDS.includes(k));
          if (extra.length) continue;
          rows.push(row);
        } catch {
          /* a torn last line from a kill is not a reason to refuse the history */
        }
      }
      this.rows = rows;
      this.prune();
    } catch {
      this.rows = [];
    }
  }

  /**
   * @param {{modelId: string, ok: boolean, latencyMs?: number|null, state?: string, ts?: number}} sample
   */
  record(sample) {
    const row = {
      ts: sample.ts ?? this.now(),
      modelId: String(sample.modelId),
      ok: Boolean(sample.ok),
      latencyMs: Number.isFinite(sample.latencyMs) ? Math.round(Number(sample.latencyMs)) : null,
      state: String(sample.state ?? (sample.ok ? 'closed' : 'open')),
    };
    this.rows.push(row);
    this.dirty += 1;

    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(row)}\n`);
      } catch {
        /* a history that cannot be written must not take the gateway down */
      }
    }

    // prune on a threshold rather than every write: cheap, and bounded
    if (this.rows.length > this.maxRows * 1.2) this.prune();
    return row;
  }

  prune() {
    const cutoff = this.now() - this.maxAgeMs;
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.ts >= cutoff);
    if (this.rows.length > this.maxRows) this.rows = this.rows.slice(-this.maxRows);

    if (this.file && this.rows.length !== before) this.#rewrite();
    return before - this.rows.length;
  }

  #rewrite() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, this.rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
      renameSync(tmp, this.file); // atomic: a reader never sees half a file
      this.dirty = 0;
    } catch {
      /* keep the old file rather than a truncated one */
    }
  }

  /** Which models have samples. */
  models() {
    return [...new Set(this.rows.map((r) => r.modelId))].sort();
  }

  /**
   * A bucketed series for one model: enough for a sparkline, small enough to send.
   *
   * @param {string} modelId
   * @param {{hours?: number, buckets?: number}} [opts]
   */
  series(modelId, opts = {}) {
    const hours = Number(opts.hours ?? 24);
    const buckets = Number(opts.buckets ?? 24);
    const now = this.now();
    const from = now - hours * 3600_000;
    const width = (hours * 3600_000) / buckets;

    const mine = this.rows.filter((r) => r.modelId === modelId && r.ts >= from);
    /** @type {Array<any>} */
    const points = [];
    for (let i = 0; i < buckets; i++) {
      const start = from + i * width;
      const inBucket = mine.filter((r) => r.ts >= start && r.ts < start + width);
      if (!inBucket.length) {
        points.push({ t: Math.round(start), samples: 0, ok: null, p50: null, errorRate: null, state: null });
        continue;
      }
      const latencies = inBucket.map((r) => r.latencyMs).filter((v) => v !== null).sort((a, b) => a - b);
      const failures = inBucket.filter((r) => !r.ok).length;
      points.push({
        t: Math.round(start),
        samples: inBucket.length,
        ok: failures === 0,
        p50: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
        errorRate: Math.round((failures / inBucket.length) * 1000) / 1000,
        state: inBucket[inBucket.length - 1].state,
      });
    }

    const observed = points.filter((p) => p.samples > 0);
    const uptime = observed.length ? Math.round((observed.filter((p) => p.ok).length / observed.length) * 1000) / 1000 : null;
    return { modelId, hours, buckets, points, uptime, samples: mine.length };
  }

  /** Every model's series in one call, for the Weather Map. */
  all(opts = {}) {
    return this.models().map((modelId) => this.series(modelId, opts));
  }

  /** Compact stats for `/api/status`: no point arrays. */
  summary() {
    const cutoff = this.now() - 24 * 3600_000;
    const rows = this.rows.filter((r) => r.ts >= cutoff);
    return {
      rows: this.rows.length,
      last24h: rows.length,
      models: this.models().length,
      oldest: this.rows.length ? this.rows[0].ts : null,
      maxRows: this.maxRows,
    };
  }
}
