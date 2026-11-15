/**
 * Background workers (B9.1).
 *
 * Nothing here is on the request path (I1). Each job is a timer that does one
 * thing, records when it last ran, and can be stopped cleanly — because a
 * gateway that will not exit on Ctrl-C is a gateway nobody restarts.
 *
 * Jobs today:
 *   prober        hourly, liveness/readiness/suitability over the catalogue (B2.3)
 *   cache_sweep   every few minutes, drop expired cache entries so memory is bounded
 *
 * Deliberately absent until their batches land: catalog_sync (B2.2),
 * quota_telemetry (B2.3 follow-on), red_team_self_test (B6.2), canary_rollout (B9.2).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prober } from '@sui/prober';
import { runSelfTest } from '@sui/redteam';
import { THRESHOLDS, checkBudgets, dedupe } from './alerts.js';
import { DriftMonitor, driftFromLedger } from '@sui/telemetry';
import { dedupeEntries, loadSeed } from '@sui/catalog';

/**
 * @param {{
 *   config: any, cache: any, ledger: any, logger?: any,
 *   catalogDir?: string, now?: () => number, prober?: any
 * }} deps
 */
export function startWorkers(deps) {
  const { config, cache, ledger } = deps;
  const logger = deps.logger ?? { info() {}, warn() {}, debug() {} };
  const now = deps.now ?? Date.now;
  const settings = config.workers ?? {};
  const enabled = settings.enabled !== false;

  /** @type {Array<{name: string, timer: any, intervalMs: number, lastRunAt: number|null, runs: number, lastError: string|null, lastResult: any}>} */
  const jobs = [];
  let prober = deps.prober ?? null;
  let stopped = false;

  if (enabled) {
    if (settings.prober?.enabled !== false) {
      const entries = loadProbeTargets(deps.catalogDir);
      if (entries.length) {
        prober = new Prober({
          entries,
          intervalMs: Number(settings.prober?.intervalMs ?? 3600_000),
          failuresBeforeDisable: Number(settings.prober?.failuresBeforeDisable ?? 3),
          timeoutMs: Number(settings.prober?.timeoutMs ?? 8000),
          now,
          onResult: (result, state) => {
            if (!result.ok) logger.warn(`probe ${result.provider}: ${result.reasons[0] ?? 'failed'} (${state.status})`);
          },
        });
        jobs.push(
          register('prober', Number(settings.prober?.intervalMs ?? 3600_000), async () => {
            const results = await prober.runOnce();
            return { probed: results.length, verified: results.filter((r) => r.verified).length };
          }),
        );
      } else {
        logger.debug('prober: no catalogue entry has a base_url to probe yet');
      }
    }

    // B6.2: attack our own routes on a schedule. A weekly run is enough to catch
    // a provider that changed behaviour; a nightly one would spend quota for the
    // same answer.
    if (settings.redTeam?.enabled === true && deps.router) {
      jobs.push(
        register('red_team_self_test', Number(settings.redTeam.intervalMs ?? 7 * 24 * 3600_000), async () => {
          const combo = settings.redTeam.combo ?? Object.keys(deps.config.combos ?? {})[0];
          if (!combo) return { skipped: 'no combo to test' };
          const report = await runSelfTest({ combo, chat: (input) => deps.router.chat(input) });
          if (!report.pass) logger.warn(`red-team self-test: ${report.counts.critical} CRITICAL, ${report.counts.high} ambiguous on "${combo}"`);
          return { combo, pass: report.pass, counts: report.counts };
        }),
      );
    }

    // B7.3: budget alerts. Cheap enough to run every minute, and deduped so a
    // threshold fires once per scope per day rather than on every tick.
    const sentAlerts = new Set();
    /** @type {Array<any>} */
    const alertLog = [];
    jobs.push(
      register('budget_alerts', Number(settings.alertIntervalMs ?? 60_000), async () => {
        const fresh = dedupe(checkBudgets({ config: deps.config, ledger: deps.ledger }), sentAlerts);
        for (const alert of fresh) {
          logger.warn(alert.message);
          alertLog.push({ ...alert, at: Date.now() });
          if (alertLog.length > 50) alertLog.shift();
        }
        return { fired: fresh.length, thresholds: THRESHOLDS };
      }),
    );
    deps.alerts = { log: () => [...alertLog], sent: () => [...sentAlerts] };

    // B3.7: drift runs on a slow timer, off the request path, and never on the
    // same samples twice — it reads what the ledger has recorded since last time.
    const driftMonitor = new DriftMonitor({ baselineSamples: 10, threshold: Number(settings.driftThreshold ?? 5) });
    jobs.push(
      register('drift_monitor', Number(settings.driftIntervalMs ?? 300_000), async () => {
        const records = deps.ledger.records ?? [];
        const { alarms } = driftFromLedger({ records, monitor: driftMonitor, since: 0, minSamples: 10 });
        for (const alarm of alarms) {
          logger.warn(`drift on ${alarm.key}: ${alarm.alarm.direction} (cusum ${alarm.alarm.cusum}, baseline ${alarm.baseline}, now ${alarm.ewma})`);
        }
        return { series: driftMonitor.series.size, alarms: alarms.length };
      }),
    );
    deps.drift = { snapshot: () => [...driftMonitor.series.keys()].map((k) => driftMonitor.snapshot(k)), alarms: () => driftMonitor.alarms() };

    const sweepMs = Number(settings.cacheSweepMs ?? 300_000);
    if (cache?.sweep && sweepMs > 0) {
      jobs.push(register('cache_sweep', sweepMs, async () => cache.sweep()));
    }
  }

  /**
   * @param {string} name
   * @param {number} intervalMs
   * @param {() => Promise<any>} run
   */
  /**
   * B9.6 — a worker that cannot pile up, cannot hammer a failing dependency, and
   * cannot drift into a thundering herd with its siblings.
   *
   *   overlap    a tick that arrives while the previous one is still running is
   *              skipped, not queued: a slow probe should not become two
   *   backoff    after a failure the interval doubles, up to 16x, and resets on
   *              the first success
   *   jitter     the first tick is offset, so six jobs do not all fire at boot
   */
  function register(name, intervalMs, run) {
    const job = {
      name,
      timer: null,
      intervalMs,
      baseIntervalMs: intervalMs,
      lastRunAt: null,
      runs: 0,
      skipped: 0,
      failures: 0,
      running: false,
      lastError: null,
      lastResult: null,
      run, // swappable, which is how the overlap guard is tested
    };

    const reschedule = (target, intervalMs) => {
      if (target.timer) clearInterval(target.timer);
      target.intervalMs = intervalMs;
      target.timer = setInterval(tick, intervalMs);
      target.timer.unref?.();
    };

    const tick = async () => {
      if (stopped) return;
      if (job.running) {
        job.skipped += 1;
        return;
      }
      job.running = true;
      try {
        job.lastResult = await job.run();
        job.lastError = null;
        if (job.failures > 0) {
          job.failures = 0;
          reschedule(job, job.baseIntervalMs);
        }
      } catch (err) {
        job.lastError = /** @type {any} */ (err)?.message ?? String(err);
        job.failures += 1;
        const backoff = Math.min(job.baseIntervalMs * 2 ** Math.min(job.failures, 4), job.baseIntervalMs * 16);
        reschedule(job, backoff);
        logger.warn(`${name} failed (${job.failures}x, next in ${Math.round(backoff / 1000)}s): ${job.lastError}`);
      } finally {
        job.running = false;
        job.lastRunAt = now();
        job.runs += 1;
      }
    };

    // First run happens shortly after boot, not during it: startup must not wait
    // on a network call (I5 wants a fresh install answering in 30s).
    // B9.6: jitter the first tick so a restart does not fire every job at once
    const kickoffMs = Number(settings.kickoffMs ?? 1500);
    const kickoff = setTimeout(tick, kickoffMs + Math.floor(Math.random() * Math.max(1, kickoffMs)));
    kickoff.unref?.();
    job.runNow = tick;
    job.timer = setInterval(tick, intervalMs);
    job.timer.unref?.();
    return job;
  }

  return {
    jobs,
    get prober() {
      return prober;
    },
    snapshot() {
      return {
        enabled,
        jobs: jobs.map((j) => ({
          name: j.name,
          intervalMs: j.intervalMs,
          runs: j.runs,
          skipped: j.skipped,
          failures: j.failures,
          lastRunAt: j.lastRunAt,
          nextRunAt: j.lastRunAt ? j.lastRunAt + j.intervalMs : null,
          lastError: j.lastError,
          lastResult: j.lastResult,
        })),
        probes: prober ? prober.snapshot() : [],
        alerts: deps.alerts?.log?.() ?? [],
      };
    },
    stop() {
      stopped = true;
      for (const job of jobs) {
        if (job.timer) clearInterval(job.timer);
        job.timer = null;
      }
    },
  };
}

/**
 * The catalogue entries worth probing: only those with a resolved base_url.
 * An identity with no endpoint is not a probe target, and pretending otherwise
 * would produce a failure that says nothing.
 */
export function loadProbeTargets(catalogDir) {
  // `sui start` runs from the user's project directory, where packages/catalog
  // does not exist. Fall back to the catalogue that shipped with the package.
  const candidates = catalogDir
    ? [catalogDir]
    : [join(process.cwd(), 'packages', 'catalog'), join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'catalog')];

  for (const dir of candidates) {
    const entries = [];
    let found = false;
    for (const file of ['seed.json', 'generated.json']) {
      try {
        entries.push(...loadSeed(join(dir, file)));
        found = true;
      } catch {
        /* a missing file is not an error: a trimmed checkout still runs */
      }
    }
    if (found) return dedupeEntries(entries).filter((e) => e.base_url);
  }
  return [];
}
