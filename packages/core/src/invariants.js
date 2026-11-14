/**
 * The invariants, as data.
 *
 * Section 2 of the project prompt is a list of hard constraints. Keeping them
 * in code — with the place that enforces each one and the test that proves it —
 * is the difference between a constraint and a wish.
 *
 * `enforced` names the module that must stay true to it. `test` names the test
 * that fails if it stops being true. If either is "none", the invariant is not
 * yet real and this table says so out loud.
 */

export const INVARIANTS = [
  {
    id: 'I1',
    statement: 'Hot path does zero discovery, zero probing, zero DB writes.',
    enforced: 'packages/router (plan is pure, precomputed) + packages/telemetry (ledger append is async-safe, cache is in-memory)',
    test: 'test/router.test.js — "plan: skipping reasons name the fix, not just the failure"',
    status: 'partial',
    gap: 'The ledger appends synchronously on the hot path. It is wrapped so it cannot fail a request, but it is not yet off-thread. Phase 3 moves it to a queue.',
  },
  {
    id: 'I2',
    statement: 'Data plane overhead target: <15ms p95 on /v1/* endpoints.',
    enforced: 'scripts/soak.mjs measures handler time with providers held constant',
    test: 'scripts/soak.mjs (CI runs a 60s soak and fails above budget)',
    status: 'measured',
    budgetMs: 15,
    gap: 'Measured by a soak run rather than gated per request, and measured against mock providers — a real provider\'s own latency is excluded, but so is its effect on our buffering.',
  },
  {
    id: 'I3',
    statement: '/v1/models responds in <1000ms, served from a precomputed table.',
    enforced: 'apps/gateway/src/server.js modelList() reads config in memory; no I/O',
    test: 'test/invariants.test.js — "I3: /v1/models answers from memory, well inside its 1000ms budget"',
    status: 'enforced',
    budgetMs: 1000,
  },
  {
    id: 'I4',
    statement: 'Paid credentials are never loaded unless paid_tiers.enabled is true.',
    enforced: 'packages/core/src/config.js providerHasCredentials() returns false for paid-tier providers when the gate is closed',
    test: 'test/invariants.test.js — "I4: a paid provider is invisible while the gate is closed"',
    status: 'enforced',
  },
  {
    id: 'I5',
    statement: 'A fresh install answers a real request with no API keys within 30s.',
    enforced: 'apps/cli onboarding: keyless/demo route, then a real round-trip before it prints ready',
    test: 'test/onboarding.test.js — "first run with no keys completes end to end on the demo provider, and says it is a demo"',
    status: 'enforced',
    budgetS: 30,
  },
  {
    id: 'I6',
    statement: 'Zero silent degradation: every escalation is traced and explainable.',
    enforced: 'packages/router records every attempt in meta.attempts and the ledger, including failures',
    test: 'test/server.test.js — "failover is invisible to the client: one 200, one provenance, one attempt list"',
    status: 'enforced',
  },
  {
    id: 'I7',
    statement: 'Every onboarding path ends with a real model round-trip, not a green check.',
    enforced: 'apps/cli/src/onboarding.js returns ok:false when the round-trip fails',
    test: 'test/onboarding.test.js — "first run refuses to report success when the round-trip fails"',
    status: 'enforced',
  },
  {
    id: 'I8',
    statement: 'Every destructive dashboard toggle previews impact and validates dependencies before commit.',
    enforced: 'packages/core/src/config.js checkToggle() + POST /api/config/validate',
    test: 'test/config.test.js — "toggle gate: a provider in use cannot be disabled, and says why"',
    status: 'enforced',
  },
  {
    id: 'I9',
    statement: 'No raw hex colours, no ad-hoc utility classes — token-based design system only.',
    enforced: 'apps/dashboard/web/dashboard.html declares tokens in :root and uses var() everywhere below it',
    test: 'test/dashboard.test.js — "I9: no raw colour value appears outside the token block"',
    status: 'enforced',
  },
  {
    id: 'I10',
    statement: 'Every PR blocks merge if the golden-set eval regresses.',
    enforced: 'evals/run.mjs compares against evals/baseline.json and exits non-zero on regression',
    test: '.github/workflows/ci.yml — eval gate step',
    status: 'enforced',
  },
  {
    id: 'I11',
    statement: 'No customer prompt content in telemetry (hash/embedding only).',
    enforced: 'packages/telemetry/src/ledger.js stores a salted hash and a length unless guardrails.logPrompts is true',
    test: 'test/invariants.test.js — "I11: the ledger keeps a hash, not the prompt"',
    status: 'enforced',
  },
  {
    id: 'I12',
    statement: 'Providers marked tos:avoid are never auto-routed.',
    enforced: 'packages/router plan(): tos === "avoid" targets are skipped unless the caller named that model explicitly',
    test: 'test/invariants.test.js — "I12: a tos:avoid provider is never chosen automatically"',
    status: 'enforced',
  },
  {
    id: 'I13',
    statement: 'Circuit breaker trips on 5xx/transport only — never on 401/404 (and not on 429).',
    enforced: 'packages/router/src/router.js classifies failures before recording them',
    test: 'test/invariants.test.js — "I13: a bad key does not rest a provider, a broken provider does"',
    status: 'enforced',
  },
  {
    id: 'I14',
    statement: 'When every provider is ejected, return the unfiltered enabled list rather than a total outage.',
    enforced: 'packages/router plan(): a second pass ignores open breakers when nothing else is left',
    test: 'test/invariants.test.js — "I14: with every breaker open, a request is still attempted"',
    status: 'enforced',
  },
  {
    id: 'I15',
    statement: 'Known security issues fixed before v1: JWT fallback secret, host-header bypass, default password.',
    enforced: 'apps/gateway (host allowlist), packages/core (hashed API keys, generated-on-first-boot secret)',
    test: 'test/security.test.js — "host allowlist: a forged Host header is refused"',
    status: 'partial',
    gap: 'Sui issues no JWTs, so there is no fallback secret to leak — the session secret is generated on first boot and stored 0600. No default password exists because there is no password login. Host-header allowlist and hashed API keys are enforced.',
  },
];

/** Look one up, for CLIs and error messages that want to quote the rule. */
export function invariant(id) {
  return INVARIANTS.find((i) => i.id === id) ?? null;
}

export const BUDGETS = {
  dataPlaneOverheadP95Ms: 15,
  modelsResponseMs: 1000,
  freshInstallSeconds: 30,
  verifierConfidence: 0.7,
  semanticCacheSimilarity: 0.98,
  semanticCacheLatencyMs: 15,
};

/**
 * Config-level invariant check. Anything that can be known without sending a
 * request is checked here, so `sui doctor` can report it before traffic.
 *
 * @param {any} config
 * @returns {Array<{id: string, ok: boolean, detail: string}>}
 */
export function auditConfig(config) {
  const results = [];

  const paidProviders = Object.entries(config.providers ?? {}).filter(([, p]) => /** @type {any} */ (p).tier === 'paid');
  const gateOpen = config.paidTiers?.enabled === true;
  results.push({
    id: 'I4',
    ok: gateOpen || paidProviders.length === 0,
    detail: gateOpen
      ? `paid tier enabled: ${paidProviders.length} paid provider(s) may load credentials`
      : `paid tier closed: ${paidProviders.length} paid provider(s) hold credentials that will not be read`,
  });

  const avoid = Object.entries(config.providers ?? {}).filter(([, p]) => /** @type {any} */ (p).tos === 'avoid');
  const avoidRouted = Object.entries(config.combos ?? {}).filter(([, c]) =>
    /** @type {any} */ (c).targets.some((t) => {
      const id = typeof t === 'string' ? t : t.model;
      const model = config.models?.[id];
      const provider = model ? config.providers?.[/** @type {any} */ (model).provider] : null;
      return provider?.tos === 'avoid';
    }),
  );
  results.push({
    id: 'I12',
    ok: avoid.length === 0 || avoidRouted.length === 0,
    detail: avoid.length
      ? `${avoid.length} provider(s) marked tos:avoid${avoidRouted.length ? `, still present in combos: ${avoidRouted.map(([id]) => id).join(', ')} (they will not be auto-routed)` : ''}`
      : 'no providers marked tos:avoid',
  });

  const plaintextKeys = (config.apiKeys ?? []).filter((k) => k.key && !k.key_hash);
  results.push({
    id: 'I15',
    ok: plaintextKeys.length === 0,
    detail: plaintextKeys.length
      ? `${plaintextKeys.length} API key(s) stored in plaintext; run \`sui keys hash\` to replace them with SHA-256 hashes`
      : 'all API keys are hashed, or none are configured',
  });

  const promptLogging = config.guardrails?.logPrompts === true;
  results.push({
    id: 'I11',
    ok: !promptLogging,
    detail: promptLogging
      ? 'guardrails.logPrompts is ON: prompt text will be written to the ledger'
      : 'prompt content is not stored (salted hash + length only)',
  });

  return results;
}
