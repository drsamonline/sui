/**
 * B7.7 — the tenant console, backend half.
 *
 * A key is a tenant (B6.6). This turns the keys in a config plus the ledger into
 * the table an operator actually needs: what each tenant has spent, what is left,
 * how fast it is going, and what it is allowed to reach.
 *
 * Two rules worth stating:
 *
 *   1. **A tenant with no cap is not at 0%.** It is uncapped, and the table says
 *      `null` rather than pretending a number.
 *   2. **The name is the identity.** Keys are stored as hashes; the console never
 *      needs the key itself, and must never print it.
 */

/**
 * @param {{config: any, ledger: any, limiter?: any, now?: () => number}} input
 */
export function tenantSnapshot(input) {
  const now = input.now ?? Date.now;
  const startOfDay = new Date(now());
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.getTime();

  const rows = input.ledger.entries({ since });

  return (input.config.apiKeys ?? []).map((key) => {
    const name = key.name ?? 'unnamed';
    const mine = rows.filter((r) => r.apiKey === name);
    const spentUsd = Math.round(mine.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 1e6) / 1e6;
    const cap = key.dailyUsd == null ? null : Number(key.dailyUsd);
    const lastSeenAt = mine.length ? Math.max(...mine.map((r) => r.ts ?? 0)) : null;

    const bucket = input.limiter?.snapshot?.().find((b) => b.key === name) ?? null;

    return {
      name,
      // the key itself is never returned; this only says whether one is stored
      hasKeyHash: Boolean(key.key_hash),
      dailyUsd: cap,
      spentUsd,
      remainingUsd: cap == null ? null : Math.max(0, Math.round((cap - spentUsd) * 1e6) / 1e6),
      pct: cap == null || cap === 0 ? null : Math.round((spentUsd / cap) * 1000) / 10,
      turns: mine.filter((r) => r.ok).length,
      failed: mine.filter((r) => !r.ok).length,
      lastSeenAt,
      rateLimit: key.rateLimit ?? null,
      bucket,
      allowedCombos: key.allowedCombos ?? null,
      allowedModels: key.allowedModels ?? null,
      guardrails: key.guardrails ?? null,
    };
  });
}

/** The headline numbers a console shows above the table. */
export function tenantSummary(snapshot) {
  const capped = snapshot.filter((t) => t.dailyUsd != null);
  return {
    tenants: snapshot.length,
    capped: capped.length,
    uncapped: snapshot.length - capped.length,
    spentUsd: Math.round(snapshot.reduce((a, t) => a + t.spentUsd, 0) * 1e6) / 1e6,
    // the tenant closest to its cap is the one worth looking at
    nearestCap: capped.length
      ? capped.reduce((worst, t) => ((t.pct ?? 0) > (worst.pct ?? 0) ? t : worst), capped[0]).name
      : null,
  };
}
