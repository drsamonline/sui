/**
 * Budget alerts (B7.3).
 *
 * A budget that is never announced is a surprise, not a control. These are the
 * thresholds the spec asks for — 75, 90 and 100 percent — applied to the daily
 * cap and to each per-provider cap.
 *
 * Two rules:
 *   1. **One alert per threshold per scope per day.** An alert that fires on every
 *      request is noise, and noise gets muted.
 *   2. **The message carries the numbers.** "Budget alert" tells nobody anything;
 *      "$4.51 of $5.00 spent today (90%)" tells them what to do.
 */

export const THRESHOLDS = [75, 90, 100];

const LEVELS = { 75: 'warning', 90: 'critical', 100: 'exhausted' };

/**
 * @param {{config: any, ledger: any, now?: () => number, dayKey?: string}} input
 * @returns {Array<{scope: string, scopeId: string, pct: number, threshold: number, level: string, message: string, key: string}>}
 */
export function checkBudgets(input) {
  const now = input.now ?? Date.now;
  const day = input.dayKey ?? new Date(now()).toISOString().slice(0, 10);
  const alerts = [];

  const consider = (scope, scopeId, spent, cap) => {
    if (cap == null || !Number.isFinite(Number(cap)) || Number(cap) <= 0) return;
    const pct = Math.round((spent / Number(cap)) * 1000) / 10;
    const threshold = [...THRESHOLDS].reverse().find((t) => pct >= t);
    if (!threshold) return;

    const level = LEVELS[threshold];
    const money = (v) => `$${Number(v).toFixed(2)}`;
    const message =
      scope === 'daily'
        ? `Daily budget ${level}: ${money(spent)} of ${money(cap)} spent today (${pct}%).`
        : `Provider budget ${level}: ${scopeId} has spent ${money(spent)} of ${money(cap)} today (${pct}%).`;

    alerts.push({ scope, scopeId, pct, threshold, level, message, key: `${day}:${scope}:${scopeId}:${threshold}` });
  };

  consider('daily', 'gateway', input.ledger.todaySpendUsd(), input.config?.budgets?.dailyUsd);

  for (const [providerId, cap] of Object.entries(input.config?.budgets?.perProvider ?? {})) {
    consider('provider', providerId, input.ledger.providerSpendToday(providerId), cap);
  }

  return alerts;
}

/**
 * Keep only alerts that have not been sent yet, and remember them.
 * @param {ReturnType<typeof checkBudgets>} alerts
 * @param {Set<string>} sent
 */
export function dedupe(alerts, sent) {
  const fresh = alerts.filter((a) => !sent.has(a.key));
  for (const a of fresh) sent.add(a.key);
  return fresh;
}
