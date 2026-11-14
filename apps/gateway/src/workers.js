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
  function register(name, intervalMs, run) {
    const job = { name, timer: null, intervalMs, lastRunAt: null, runs: 0, lastError: null, lastResult: null };

    const tick = async () => {
      if (stopped) return;
      try {
        job.lastResult = await run();
        job.lastError = null;
      } catch (err) {
        job.lastError = /** @type {any} */ (err)?.message ?? String(err);
        logger.warn(`${name} failed: ${job.lastError}`);
      } finally {
        job.lastRunAt = now();
        job.runs += 1;
      }
    };

    // First run happens shortly after boot, not during it: startup must not wait
    // on a network call (I5 wants a fresh install answering in 30s).
    const kickoff = setTimeout(tick, Number(settings.kickoffMs ?? 1500));
    kickoff.unref?.();
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
          lastRunAt: j.lastRunAt,
          nextRunAt: j.lastRunAt ? j.lastRunAt + j.intervalMs : null,
          lastError: j.lastError,
          lastResult: j.lastResult,
        })),
        probes: prober ? prober.snapshot() : [],
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
