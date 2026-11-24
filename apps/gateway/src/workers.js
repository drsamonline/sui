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

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prober } from '@drsamonline/prober';
import { runSelfTest } from '@drsamonline/redteam';
import { THRESHOLDS, checkBudgets, dedupe } from './alerts.js';
import { DriftMonitor, HistoryStore, driftFromLedger } from '@drsamonline/telemetry';
import { dedupeEntries, loadSeed } from '@drsamonline/catalog';

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
    // B2.7: created before any job, so /api/history works even when the prober
    // is switched off — the history file is the record, not the prober's memory.
    const history = new HistoryStore({
      file: deps.historyFile ?? settings.historyFile ?? null,
      maxRows: Number(settings.historyMaxRows ?? 20_000),
    });
    deps.history = history;

    if (settings.prober?.enabled !== false) {
      const entries = loadProbeTargets(deps.catalogDir);
      if (entries.length) {
        prober = new Prober({
          entries,
          // a loopback target is opt-in, like everywhere else: a probe sweep must
          // not touch the user's own machine unless the config says so
          allowLocal: settings.prober?.allowLocal === true,
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
            // B2.7: one sample per target per pass — a timestamp, an id, a
            // duration and a boolean. There is nowhere for a prompt to go.
            for (const result of results) {
              history.record({
                modelId: result.pool_key ?? result.provider ?? 'unknown',
                ok: Boolean(result.ok),
                latencyMs: result.latencyMs ?? null,
                state: result.ok ? 'closed' : 'open',
                ts: result.checkedAt ?? Date.now(),
              });
            }
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
    const alertMs = intervalFor(settings.alertIntervalMs, 60_000);
    if (alertMs) jobs.push(
      register('budget_alerts', alertMs, async () => {
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
    const driftMs = intervalFor(settings.driftIntervalMs, 300_000);
    if (driftMs) jobs.push(
      register('drift_monitor', driftMs, async () => {
        const records = deps.ledger.records ?? [];
        const { alarms } = driftFromLedger({ records, monitor: driftMonitor, since: 0, minSamples: 10 });
        for (const alarm of alarms) {
          logger.warn(`drift on ${alarm.key}: ${alarm.alarm.direction} (cusum ${alarm.alarm.cusum}, baseline ${alarm.baseline}, now ${alarm.ewma})`);
        }
        return { series: driftMonitor.series.size, alarms: alarms.length };
      }),
    );
    deps.drift = { snapshot: () => [...driftMonitor.series.keys()].map((k) => driftMonitor.snapshot(k)), alarms: () => driftMonitor.alarms() };

    const sweepMs = intervalFor(settings.cacheSweepMs, 300_000);
    if (cache?.sweep && sweepMs) {
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
  /**
   * An interval that is not a positive number means "this job is off".
   *
   * `setInterval(fn, 0)` is not a fast timer, it is a busy loop: the callback
   * runs again the moment the previous one yields, which pegs a core and starves
   * every other timer in the process. A config value of 0 read as "off" is the
   * only sane interpretation, and `0 ?? fallback` does not give it — nullish
   * coalescing only replaces null and undefined.
   */
  function intervalFor(value, fallback) {
    const ms = Number(value ?? fallback);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

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
    // B2.7: the store is on the returned object, not only on `deps`, so a caller
    // does not have to know how startWorkers was wired internally.
    get history() {
      return deps.history ?? null;
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
        drift: deps.drift?.alarms?.() ?? [],
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
 * Where the catalogue lives, most specific first.
 *
 * `sui start` runs from the user's project directory, where `packages/catalog`
 * does not exist — and neither does the path three levels above this file once the
 * gateway is inside `node_modules`. Both fallbacks therefore pointed at nothing on
 * an install, so the background prober found zero entries and quietly never ran:
 * `sui probe` worked (it resolves the package) while the worker that is supposed
 * to keep routes verified did nothing. The package is asked first now, because the
 * package is the only thing that exists in both places.
 */
export function catalogueDirs(catalogDir) {
  if (catalogDir) return [catalogDir];
  const dirs = [];
  try {
    dirs.push(dirname(fileURLToPath(import.meta.resolve('@drsamonline/catalog/seed.json'))));
  } catch {
    // an older install may not export seed.json; the checkout path below still works
  }
  dirs.push(join(process.cwd(), 'packages', 'catalog'));
  dirs.push(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'catalog'));
  return dirs;
}

/**
 * Every catalogue entry, identities included — and what could not be read.
 *
 * A missing file is not an error: a trimmed checkout still runs. A *broken* file
 * is, and it used to be indistinguishable from a missing one, so a single
 * malformed entry in `generated.json` made the whole catalogue vanish and both the
 * prober and the providers page report zero providers. The two are told apart
 * here, and the caller decides how loudly to say it.
 *
 * @returns {{entries: any[], problems: Array<{file: string, message: string}>}}
 */
export function loadCatalogueDetailed(catalogDir) {
  for (const dir of catalogueDirs(catalogDir)) {
    const entries = [];
    const problems = [];
    let found = false;
    for (const file of ['seed.json', 'generated.json']) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      found = true;
      try {
        entries.push(...loadSeed(path));
      } catch (err) {
        problems.push({ file: path, message: String(/** @type {any} */ (err)?.message ?? err) });
      }
    }
    if (found) return { entries: dedupeEntries(entries), problems };
  }
  return { entries: [], problems: [] };
}

/** Every catalogue entry, identities included. */
export function loadCatalogue(catalogDir) {
  return loadCatalogueDetailed(catalogDir).entries;
}

/**
 * The catalogue entries worth probing: only those with a resolved base_url.
 * An identity with no endpoint is not a probe target, and pretending otherwise
 * would produce a failure that says nothing.
 */
export function loadProbeTargets(catalogDir) {
  return loadCatalogue(catalogDir).filter((e) => e.base_url);
}
