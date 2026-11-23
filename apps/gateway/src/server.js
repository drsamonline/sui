/**
 * HTTP surface.
 *
 *   POST /v1/chat/completions   OpenAI-compatible. Point any tool at it.
 *   GET  /v1/models             the combos, as model objects
 *   GET  /api/status            everything the dashboard renders, in one call
 *   GET  /api/metrics           aggregates: cost, latency, per provider/model/combo/arm
 *   GET  /api/metrics.csv       the same, as a spreadsheet export
 *   GET  /api/traces            prompt-free usage (hashes, not prompts)
 *   GET  /api/config            sanitised config (no secrets)
 *   POST /api/config/validate   the dashboard's commit gate for a toggle
 *   POST /api/breaker/reset     bring a resting model back early
 *   POST /api/cache/clear
 *   GET  /healthz
 *   GET  /                      the dashboard
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunRegistry } from '@drsamonline/guardrails';
import { createModelPlaneClient, createPlaneGuard, describePlane } from './planes.js';
import { autoCombo, checkToggle, direction, normaliseLocale, sanitizeConfig, STRINGS, providerHasCredentials, providerMeetsPrivacyTier, verifyApiKey, hashApiKey, INVARIANTS, auditConfig, BUDGETS, PRIVACY_TIERS, REGIONS, tenantSnapshot, tenantSummary, suiHome } from '@drsamonline/core';
import { SuiError } from '@drsamonline/core';
import { applyVerified, poolKey, readVerifiedOverlay } from '@drsamonline/catalog';
import { probeTarget } from '@drsamonline/prober';
import { loadCatalogue } from './workers.js';
import { explainPlan } from '@drsamonline/router';
import { PRESETS, compress as compressText } from '@drsamonline/compression';
import { Admission, RateLimiter, checkKeyBudget } from './limits.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Where the dashboard lives.
 *
 * Inside this repository it is apps/dashboard/web/dashboard.html. From an npm
 * install only apps/gateway/web/dashboard.html exists, because that is what the
 * package ships — the first version walked up to a directory that is not there and
 * served "Dashboard file missing" to every user. Both are tried, packaged first,
 * because the packaged one is what a stranger has.
 */
const DASHBOARD = [
  join(HERE, '..', 'web', 'dashboard.html'),
  join(HERE, '..', '..', 'dashboard', 'web', 'dashboard.html'),
].find((candidate) => existsSync(candidate)) ?? join(HERE, '..', 'web', 'dashboard.html');

/**
 * @param {{router: any, config: any, ledger: any, breaker: any, cache: any, logger?: any}} deps
 */
export function createSuiServer(deps) {
  const { router, config, ledger, breaker, cache, workers, canary } = deps;
  // B5.5: one run registry per process. A run is a caller-supplied id with
  // bounds; a request that names one is counted, costed and gated.
  const runs = new RunRegistry({});
  // B5.7: which half of the split this process is
  const planes = config.planes ?? { role: 'both', modelPlaneUrl: null, serviceTokenEnv: 'SUI_PLANE_TOKEN' };
  const planeToken = config.env?.[planes.serviceTokenEnv] ?? process.env[planes.serviceTokenEnv] ?? '';
  const guard = createPlaneGuard({ serviceToken: planeToken, role: planes.role });
  let planesInfo = describePlane({
    role: planes.role,
    modelPlaneUrl: planes.modelPlaneUrl,
    hasServiceToken: Boolean(planeToken),
    hasProviderCredentials: planes.role !== 'agent',
  });

  // An agent plane that cannot reach its model plane should still start, so that
  // /api/status can say what is wrong. A process that dies on boot with a stack
  // trace tells the operator nothing they can act on.
  let modelPlane = null;
  let modelPlaneError = null;
  if (planes.role === 'agent') {
    if (!planes.modelPlaneUrl) {
      modelPlaneError = 'This is the agent plane and no modelPlaneUrl is configured. Set planes.modelPlaneUrl or pass --model-plane <url>.';
    } else if (!planeToken) {
      modelPlaneError = `The agent plane needs a service token to reach the model plane. Set ${planes.serviceTokenEnv} to the same value on both planes (generate one with: openssl rand -hex 32).`;
    } else {
      try {
        modelPlane = createModelPlaneClient({ modelPlaneUrl: planes.modelPlaneUrl, serviceToken: planeToken });
      } catch (err) {
        modelPlaneError = /** @type {any} */ (err)?.message ?? String(err);
      }
    }
    if (modelPlaneError) (deps.logger ?? console).warn?.(`agent plane: ${modelPlaneError}`);
    // the reason travels with the plane description, so /api/status can show it
    planesInfo = { ...planesInfo, error: modelPlaneError };
  }
  // declared here so the plane-error block above can annotate it
  const logger = deps.logger ?? { info() {}, warn() {}, debug() {} };
  const limiter = deps.limiter ?? new RateLimiter();
  // Adaptive admission: hold a request for a slot instead of answering 503 the
  // moment the gateway is busy, and refuse with a wait only when the queue itself
  // is full.
  const admission =
    deps.admission ??
    new Admission({
      maxConcurrent: Number(config.server?.admission?.maxConcurrent ?? 64),
      queueMax: Number(config.server?.admission?.queueMax ?? 256),
      maxWaitMs: Number(config.server?.admission?.maxWaitMs ?? 5000),
    });
  let configRef = config;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Cross-origin is off by default.
    //
    // A gateway on 127.0.0.1 is reachable by any web page the user has open, and
    // the Host-header guard does not stop it — a page at evil.example calling
    // http://127.0.0.1:8787 sends the allowed Host. `Access-Control-Allow-Origin:
    // *` then let that page read the answers and spend the quota. Node clients
    // (Cline, Continue, the SDK) ignore CORS entirely, so denying it by default
    // costs them nothing; a browser-based tool has to be named in
    // server.corsOrigins.
    const origin = req.headers.origin;
    const allowedOrigins = configRef.server?.corsOrigins ?? [];
    if (origin && allowedOrigins.length) {
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.setHeader('access-control-allow-origin', allowedOrigins.includes('*') ? '*' : origin);
        res.setHeader('vary', 'origin');
        res.setHeader('access-control-allow-headers', 'authorization, content-type, x-sui-key');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // I15: Host-header allowlist. Without this, a DNS-rebinding page can reach a
    // localhost gateway from a browser tab and read the dashboard API.
    if (!hostAllowed(configRef, req.headers.host)) {
      return sendJson(res, 403, {
        error: {
          message: `This gateway does not answer to the host "${req.headers.host}". Allowed: ${allowedHostNames(configRef).join(', ')}. Add yours to server.allowedHosts if this is intended.`,
          type: 'host_not_allowed',
        },
      });
    }

    try {
      // B5.7: the plane boundary comes first, or a route that returns early
      // would serve a caller the model plane should have refused.
      const planeCheck = guard.check(req, path);
      if (!planeCheck.ok) {
        throw new SuiError(planeCheck.message, { code: planeCheck.code, status: planeCheck.status });
      }

      if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
        // Headless: the proxy engine only. A gateway on a VPS should not serve a
        // dashboard that can change its own config, and the page is the largest
        // thing it would otherwise ship.
        if (config.headless) {
          return sendJson(res, 404, {
            error: { message: 'This gateway runs headless: no dashboard is served. The OpenAI-compatible API is at /v1.', type: 'not_found' },
          });
        }
        return sendHtml(res, readDashboard());
      }
      if (req.method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'sui-router', uptimeSeconds: Math.round(process.uptime()) });
      }

      // ---- OpenAI-compatible surface -------------------------------------
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        return await handleChat(req, res);
      }
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        return sendJson(res, 200, { object: 'list', data: modelList(configRef, url.searchParams.get('all') === '1') });
      }

      // ---- dashboard API --------------------------------------------------
      if (req.method === 'GET' && path === '/api/status') {
        return sendJson(res, 200, {
          ...statusPayload(configRef, ledger, breaker, cache, router, workers, planesInfo),
          // the dashboard has no build step, so the strings it needs travel with
          // the data it already fetches
          locale: {
            code: normaliseLocale(configRef.locale ?? process.env.SUI_LANG ?? 'en'),
            dir: direction(configRef.locale ?? process.env.SUI_LANG ?? 'en'),
            strings: STRINGS[normaliseLocale(configRef.locale ?? process.env.SUI_LANG ?? 'en')] ?? STRINGS.en,
          },
        });
      }
      // B5.5: bounded runs. A caller that names a run gets its calls counted,
      // costed and gated; a caller that does not is unbounded, exactly as before.
      if (path === '/api/runs' || path.startsWith('/api/runs/')) {
        if (req.method === 'POST' && path === '/api/runs') {
          const body = await readJson(req);
          const id = String(body.id ?? `run-${Date.now().toString(36)}`);
          if (runs.get(id)) throw new SuiError(`Run "${id}" already exists.`, { code: 'run_exists', status: 409 });
          const tracker = runs.start(id, body.limits ?? {});
          return sendJson(res, 201, { id, run: tracker.snapshot() });
        }

        if (req.method === 'GET' && path === '/api/runs') {
          return sendJson(res, 200, { runs: runs.list() });
        }

        const rest = path.slice('/api/runs/'.length).split('/');
        const id = decodeURIComponent(rest[0]);
        const tracker = runs.get(id);
        if (!tracker) throw new SuiError(`No run called "${id}".`, { code: 'unknown_run', status: 404 });

        if (req.method === 'GET' && rest.length === 1) return sendJson(res, 200, { id, run: tracker.snapshot() });

        if (req.method === 'POST' && rest[1] === 'approve') {
          const body = await readJson(req);
          if (!body.tool) throw new SuiError('Say which tool to approve.', { code: 'bad_approval', status: 400 });
          const signature = tracker.approve({ tool: String(body.tool), input: body.input ?? {} });
          return sendJson(res, 200, { id, approved: signature, run: tracker.snapshot() });
        }

        if (req.method === 'POST' && rest[1] === 'finish') {
          runs.finish(id);
          return sendJson(res, 200, { id, run: tracker.snapshot() });
        }
      }

      // B2.7: health over time. Bucketed, prompt-free, and bounded.
      if (req.method === 'GET' && path === '/api/history') {
        const history = workers?.history;
        if (!history) return sendJson(res, 200, { enabled: false, series: [] });
        const model = url.searchParams.get('model');
        const hours = Number(url.searchParams.get('hours') ?? 24);
        const buckets = Number(url.searchParams.get('buckets') ?? 24);
        const series = model ? [history.series(model, { hours, buckets })] : history.all({ hours, buckets });
        return sendJson(res, 200, { enabled: true, hours, buckets, series, summary: history.summary() });
      }

      if (req.method === 'GET' && path === '/api/metrics') {
        const since = sinceParam(url);
        return sendJson(res, 200, ledger.aggregate({ since }));
      }
      if (req.method === 'GET' && path === '/api/metrics.csv') {
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="sui-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
        });
        return res.end(ledger.csv());
      }
      if (req.method === 'GET' && path === '/api/savings') {
        const since = sinceParam(url);
        const agg = ledger.aggregate({ since });
        return sendJson(res, 200, {
          since: agg.since,
          savings: agg.totals.savings,
          spentUsd: agg.totals.costUsd,
          turns: agg.totals.turns,
          // what the same turns would have cost without cache hits and compression
          avoidedShare: agg.totals.costUsd + agg.totals.savings.totalUsd
            ? Math.round((agg.totals.savings.totalUsd / (agg.totals.costUsd + agg.totals.savings.totalUsd)) * 1000) / 1000
            : 0,
        });
      }
      if (req.method === 'GET' && path === '/api/traces') {
        return sendJson(res, 200, { prompts: ledger.promptUsage(50), note: 'Hashes only. Prompt text is never stored unless guardrails.logPrompts is on.' });
      }
      // B7.4: explain a route without sending a request. The plan is a pure
      // function of config plus ledger, so this costs nothing and stores nothing.
      if (req.method === 'GET' && path === '/api/explain') {
        const combo = url.searchParams.get('combo') ?? Object.keys(configRef.combos)[0];
        try {
          const plan = router.plan(combo, {});
          return sendJson(res, 200, { combo, lines: explainPlan(plan), plan: { ordered: plan.ordered.map((t) => t.modelId), resting: plan.resting.map((t) => t.modelId), skipped: plan.skipped } });
        } catch (err) {
          throw new SuiError(/** @type {any} */ (err).message, { code: 'unknown_combo', status: 404 });
        }
      }
      // B10.5: the last eval run, if one has been done on this machine.
      // B10.4: what a preset would do to a prompt. The text is used and dropped:
      // it is never logged, never stored, and never sent to a provider.
      if (req.method === 'POST' && path === '/api/compress') {
        const body = await readJson(req);
        const text = String(body.text ?? '');
        const preset = String(body.preset ?? 'standard');
        if (!PRESETS[preset]) {
          throw new SuiError(`Unknown preset "${preset}". Use: ${Object.keys(PRESETS).join(', ')}.`, {
            code: 'bad_preset',
            status: 400,
          });
        }
        if (!text.trim()) throw new SuiError('Send some text to compress.', { code: 'empty_text', status: 400 });
        // The body limit is 20 MB, but compression is CPU-bound: a 20 MB prompt
        // would hold the event loop for seconds. This endpoint is a preview, so
        // it takes a preview-sized input.
        if (text.length > 200_000) {
          throw new SuiError('That is too long to preview — send up to 200,000 characters.', {
            code: 'text_too_long',
            status: 413,
          });
        }

        const result = compressText(text, { preset });
        return sendJson(res, 200, {
          preset: result.preset,
          originalChars: result.originalChars,
          compressedChars: result.compressedChars,
          ratio: result.ratio,
          savedChars: result.savedChars,
          skipped: result.skipped,
          steps: result.steps,
          // the compressed text is returned so a person can read it, and that is
          // the only place it exists
          text: result.text,
          note: 'Computed locally. Nothing was stored, logged or sent to a provider.',
        });
      }

      // B7.3: what the budget monitor has announced today.
      if (req.method === 'GET' && path === '/api/alerts') {
        const snap = workers?.snapshot?.() ?? { alerts: [] };
        const spent = ledger.todaySpendUsd();
        const cap = configRef.budgets?.dailyUsd ?? null;
        return sendJson(res, 200, {
          spentUsd: Math.round(spent * 1e6) / 1e6,
          dailyUsd: cap,
          pct: cap ? Math.round((spent / cap) * 1000) / 10 : null,
          thresholds: [75, 90, 100],
          alerts: snap.alerts ?? [],
        });
      }
      if (req.method === 'GET' && path === '/api/evals') {
        // `sui eval` writes its report to the user's home from an install and to
        // the checkout's committed artifact in a clone. Reading only the second
        // path meant the dashboard of an installed gateway always said "no eval
        // has been run here yet", however many times the user ran one.
        const candidates = [
          process.env.SUI_EVAL_REPORT,
          join(suiHome(process.env), 'eval-last-report.json'),
          join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'evals', 'last-report.json'),
        ].filter(Boolean);
        const reportPath = candidates.find((candidate) => existsSync(candidate));
        if (!reportPath) {
          return sendJson(res, 200, {
            available: false,
            message: 'No eval has been run here yet. Run `sui eval` (or `sui eval --self-test` to check the graders).',
          });
        }
        try {
          return sendJson(res, 200, { available: true, report: JSON.parse(readFileSync(reportPath, 'utf8')) });
        } catch (err) {
          return sendJson(res, 200, { available: false, message: `The eval report could not be read: ${/** @type {any} */ (err).message}` });
        }
      }
      if (req.method === 'GET' && path === '/api/canary') {
        return sendJson(res, 200, canary ? canary.snapshot() : { enabled: false, message: 'No canary is configured. See canary in sui.config.json.' });
      }
      if (req.method === 'POST' && path === '/api/canary/rollback') {
        if (!canary) throw new SuiError('No canary is configured.', { code: 'no_canary', status: 404 });
        const result = canary.rollback('rolled back by an operator');
        return sendJson(res, 200, { ...result, snapshot: canary.snapshot() });
      }
      // B7.7: the tenant console. Read-only by default; writes need an admin
      // token when one is configured, because a console that can raise a cap is
      // a console that can spend your money.
      if (path === '/api/tenants' || path.startsWith('/api/tenants/')) {
        requireAdmin(req, configRef, { write: req.method === 'PATCH' });
        const tenants = tenantSnapshot({ config: configRef, ledger, limiter });

        if (req.method === 'GET' && path === '/api/tenants') {
          return sendJson(res, 200, { summary: tenantSummary(tenants), tenants });
        }

        const name = decodeURIComponent(path.slice('/api/tenants/'.length));
        const tenant = tenants.find((t) => t.name === name);
        if (!tenant) throw new SuiError(`No tenant called "${name}".`, { code: 'unknown_tenant', status: 404 });

        if (req.method === 'GET') return sendJson(res, 200, tenant);

        if (req.method === 'PATCH') {
          const body = await readJson(req);
          const key = (configRef.apiKeys ?? []).find((k) => (k.name ?? 'unnamed') === name);
          if (!key) throw new SuiError(`No tenant called "${name}".`, { code: 'unknown_tenant', status: 404 });

          const changed = {};
          if (body.dailyUsd !== undefined) {
            const value = body.dailyUsd === null ? null : Number(body.dailyUsd);
            if (value !== null && (!Number.isFinite(value) || value < 0)) {
              throw new SuiError('dailyUsd must be a number of zero or more, or null for uncapped.', { code: 'bad_budget', status: 400 });
            }
            changed.dailyUsd = { from: key.dailyUsd ?? null, to: value };
            key.dailyUsd = value ?? undefined;
            if (value === null) delete key.dailyUsd;
          }
          if (body.rpm !== undefined) {
            const value = Number(body.rpm);
            if (!Number.isFinite(value) || value < 0) {
              throw new SuiError('rpm must be a number of zero or more.', { code: 'bad_rate', status: 400 });
            }
            key.rateLimit = { ...(key.rateLimit ?? {}), rpm: value };
            changed.rpm = { to: value };
          }
          if (!Object.keys(changed).length) {
            throw new SuiError('Nothing to change. Send dailyUsd or rpm.', { code: 'nothing_to_change', status: 400 });
          }

          const updated = tenantSnapshot({ config: configRef, ledger, limiter }).find((t) => t.name === name);
          return sendJson(res, 200, {
            tenant: updated,
            changed,
            note: 'Applied in memory for this process. Edit sui.config.json to make it permanent.',
          });
        }
      }

      // The catalogue, on the page. Until this existed the only way to see what
      // this gateway *could* route to was `sui catalog` on a terminal: the
      // dashboard showed the models that answered and nothing about the forty-odd
      // identities waiting for a probe, which is the product's whole story.
      if (req.method === 'GET' && path === '/api/providers') {
        return sendJson(res, 200, { ...providerReport(configRef, workers), probeEnabled: configRef.dashboard?.allowProbe === true });
      }

      // Probing from the page: a network action taken on the operator's behalf, so
      // it needs consent twice — a config flag that is off by default, and the
      // admin token unless the gateway is on loopback. One provider per request,
      // because forty at once is a sweep, and a sweep belongs on the command line
      // where its cost is visible.
      if (req.method === 'POST' && path === '/api/providers/probe') {
        if (configRef.dashboard?.allowProbe !== true) {
          throw new SuiError(
            'Probing from the dashboard is off. Set dashboard.allowProbe = true in sui.config.json, or run `sui probe <provider>` in a terminal.',
            { code: 'probe_disabled', status: 403 },
          );
        }
        requireAdmin(req, configRef, { write: true });

        const body = await readJson(req);
        const name = String(body.provider ?? '');
        const entry = catalogueWithOverlay().find((e) => e.provider === name);
        if (!entry) throw new SuiError(`No catalogue entry called "${name}".`, { code: 'unknown_provider', status: 404 });

        // The timeout comes from the request, so it is clamped: an unbounded one
        // holds a socket for as long as the caller likes, which turns one click
        // into a way to keep this process busy.
        const timeoutMs = clampProbeTimeout(body.timeoutMs);
        const result = await probeTarget(entry, { timeoutMs });
        return sendJson(res, 200, {
          provider: name,
          // what was actually used, after clamping: a caller that asked for an
          // hour should be able to see it got thirty seconds
          timeoutMs,
          result,
          // A probe reports; it does not promote. Promoting a route from a browser
          // click is the one step that stays deliberate.
          promoted: false,
          note: 'A probe reports. `sui probe --write` is what promotes a route.',
        });
      }

      if (req.method === 'GET' && path === '/api/limits') {
        return sendJson(res, 200, { buckets: limiter.snapshot(), keys: (configRef.apiKeys ?? []).map((k) => ({ name: k.name ?? 'unnamed', rateLimit: k.rateLimit ?? null, dailyUsd: k.dailyUsd ?? null })) });
      }
      if (req.method === 'GET' && path === '/api/workers') {
        return sendJson(res, 200, workers ? workers.snapshot() : { enabled: false, jobs: [], probes: [] });
      }
      if (req.method === 'GET' && path === '/api/invariants') {
        return sendJson(res, 200, {
          invariants: INVARIANTS,
          budgets: BUDGETS,
          audit: auditConfig(configRef),
          paidTiers: { enabled: configRef.paidTiers?.enabled === true },
        });
      }
      if (req.method === 'GET' && path === '/api/config') {
        return sendJson(res, 200, sanitizeConfig(configRef));
      }
      if (req.method === 'POST' && path === '/api/config/validate') {
        const patch = await readJson(req);
        const result = checkToggle(configRef, patch);
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (req.method === 'POST' && path === '/api/breaker/reset') {
        const body = await readJson(req).catch(() => ({}));
        if (body?.modelId) breaker.reset(body.modelId);
        else breaker.resetAll();
        return sendJson(res, 200, { ok: true, breakers: breaker.snapshot() });
      }
      if (req.method === 'POST' && path === '/api/cache/clear') {
        cache.clear();
        return sendJson(res, 200, { ok: true, cache: cache.stats() });
      }

      return sendJson(res, 404, { error: { message: `No route for ${req.method} ${path}.`, type: 'not_found' } });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (res.headersSent) {
        try {
          res.end();
        } catch {}
        return;
      }
      // an admission refusal carries the wait it would have needed, so a client
      // can back off instead of hammering
      if (e?.retryAfterMs) res.setHeader('retry-after', String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))));
      const status = e instanceof SuiError ? e.status : e?.status ?? 500;
      const payload =
        e instanceof SuiError
          ? e.toJSON()
          : e?.code === 'overloaded'
            ? { error: { message: e.message, type: 'overloaded' } }
            : { error: { message: 'Something went wrong inside the gateway. The details are in the server log.', type: 'internal_error' } };
      logger.warn(`request failed: ${e?.message}`);
      return sendJson(res, status, payload);
    }
  });

  /** @param {any} req @param {any} res */
  async function handleChat(req, res) {
    const body = await readJson(req);
    const keyMeta = authorise(req, configRef);

    // B6.6: a key is a tenant — its rate and its spend cap are checked before
    // any provider is chosen, so a cheap combo cannot be used to bypass them.
    if (keyMeta) {
      const keyId = keyMeta.name ?? 'unnamed';
      const rate = limiter.check(keyId, keyMeta.rateLimit ?? {});
      if (!rate.ok) {
        res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
        throw new SuiError(
          `This API key is over its rate limit (${rate.limit} requests/minute). Try again in ${Math.max(1, Math.ceil(rate.retryAfterMs / 1000))}s.`,
          { code: 'rate_limited', status: 429, retryable: true, detail: `key: ${keyId}` },
        );
      }
      const budget = checkKeyBudget({ keyMeta, ledger });
      if (!budget.ok) {
        throw new SuiError(budget.message, { code: 'key_budget_reached', status: 429, retryable: false, detail: `key: ${keyId}` });
      }
    }

    // Held until a slot frees, or refused with a wait. Released in a finally so a
    // thrown provider error cannot leak a slot and slowly strangle the gateway.
    const release = await admission.acquire();
    let released = false;
    const free = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    res.on('close', free);

    // A key can be pinned to one model or combo. `forcedModel` is the whole point
    // of a per-tenant key for a shared deployment: the caller does not choose, the
    // key does, and a request naming something else is refused rather than
    // quietly routed somewhere the operator did not intend.
    if (keyMeta?.forcedModel) {
      if (body.model && body.model !== keyMeta.forcedModel) {
        throw new SuiError(
          `This API key is pinned to "${keyMeta.forcedModel}" and may not request "${body.model}".`,
          { code: 'forced_model', status: 403 },
        );
      }
      body.model = keyMeta.forcedModel;
    }

    const requested = body.model ?? Object.keys(configRef.combos)[0];
    if (!configRef.combos[requested] && !configRef.models[requested]) {
      throw new SuiError(
        `"${requested}" is not a combo or model this gateway knows. Available: ${[...Object.keys(configRef.combos), ...Object.keys(configRef.models)].join(', ')}. Call GET /v1/models for the list.`,
        { code: 'unknown_model', status: 404 },
      );
    }
    if (keyMeta?.allowedCombos && !keyMeta.allowedCombos.includes(requested)) {
      throw new SuiError(`This API key may not use "${requested}".`, { code: 'forbidden_model', status: 403 });
    }

    const stream = Boolean(body.stream);
    const startedAt = Date.now();
    // I2 measures OUR overhead, so it is measured here, on the server side.
    // Client sockets, DNS and JSON serialisation belong to the caller, not to us.
    const handlerStart = performance.now();
    /** @type {{provider?: string, modelId?: string, model?: string, name?: string}|null} */
    let target = null;
    /** @type {boolean} */
    let committed = false;

    /** @param {string} delta */
    const onToken = (delta) => {
      if (!committed) {
        committed = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-sui-provider': String(target?.providerId ?? ''),
          'x-sui-model': String(target?.model ?? ''),
          'x-sui-combo': String(requested),
          'x-sui-ttft-ms': String(Date.now() - startedAt),
        });
        res.write(
          sse({
            id: `chatcmpl-sui-${startedAt}`,
            object: 'chat.completion.chunk',
            created: Math.floor(startedAt / 1000),
            model: requested,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          }),
        );
      }
      res.write(
        sse({
          id: `chatcmpl-sui-${startedAt}`,
          object: 'chat.completion.chunk',
          created: Math.floor(startedAt / 1000),
          model: requested,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        }),
      );
    };

    // B6.5: a caller may ask for a stricter privacy tier than the default.
    const requestedTier = String(
      req.headers['x-sui-privacy'] ?? body.sui_privacy ?? configRef.privacy?.defaultTier ?? 'any',
    );
    if (!PRIVACY_TIERS.includes(requestedTier)) {
      throw new SuiError(`Unknown privacy tier "${requestedTier}". Use ${PRIVACY_TIERS.join(', ')}.`, {
        code: 'bad_privacy_tier',
        status: 400,
      });
    }

    // B7.1: attribution the caller supplies. Nothing is inferred beyond the key
    // name and the user agent, and neither is treated as identity.
    const attribution = {
      user: String(req.headers['x-sui-user'] ?? keyMeta?.name ?? 'unattributed').slice(0, 64),
      tool: String(req.headers['x-sui-tool'] ?? shortAgent(req.headers['user-agent']) ?? 'unattributed').slice(0, 64),
    };

    // B6.6: a caller may require a region, exactly like a privacy tier
    const requestedRegion = String(req.headers['x-sui-region'] ?? body.sui_region ?? configRef.privacy?.region ?? 'any');
    if (!REGIONS.includes(requestedRegion)) {
      throw new SuiError(`Unknown region "${requestedRegion}". Use ${REGIONS.join(', ')}.`, { code: 'bad_region', status: 400 });
    }

    // B5.5: a named run is bounded. The check happens before the call, and the
    // record happens after, so a loop cannot slip past on a technicality.
    const runId = req.headers['x-sui-run'] ? String(req.headers['x-sui-run']) : null;
    const tracker = runId ? runs.get(runId) : null;
    if (runId && !tracker) {
      throw new SuiError(`No run called "${runId}". Create one with POST /api/runs first.`, { code: 'unknown_run', status: 404 });
    }
    if (tracker) {
      const decision = tracker.check({ tool: 'chat', input: { combo: requested, prompt: body?.messages?.at(-1)?.content ?? '' } });
      if (decision.decision === 'deny') {
        throw new SuiError(decision.reason, { code: 'run_bounded', status: 409, detail: decision.signature });
      }
      if (decision.decision === 'needsApproval') {
        throw new SuiError(decision.reason, { code: 'run_needs_approval', status: 409, detail: decision.signature });
      }
    }

    // B5.7: an agent plane has no providers. It bounds the run, then asks the
    // model plane to do the work.
    if (planes.role === 'agent') {
      if (tracker) {
        const decision = tracker.check({ tool: 'chat', input: { combo: requested, prompt: body?.messages?.at(-1)?.content ?? '' } });
        if (decision.decision !== 'allow') {
          throw new SuiError(decision.reason, {
            code: decision.decision === 'deny' ? 'run_bounded' : 'run_needs_approval',
            status: 409,
            detail: decision.signature,
          });
        }
      }
      if (!modelPlane) {
        throw new SuiError(modelPlaneError ?? 'This agent plane cannot reach a model plane.', {
          code: 'model_plane_not_configured',
          status: 503,
        });
      }
      const forwarded = await modelPlane.forward({
        path: '/v1/chat/completions',
        method: 'POST',
        body,
        headers: { 'x-sui-user': attribution.user, 'x-sui-tool': attribution.tool, 'x-sui-region': requestedRegion },
      });
      if (tracker && forwarded.status === 200) {
        tracker.record({
          tool: 'chat',
          input: { combo: requested, prompt: body?.messages?.at(-1)?.content ?? '' },
          costUsd: forwarded.json?.sui?.costUsd ?? 0,
        });
      }
      res.writeHead(forwarded.status, { 'content-type': 'application/json' });
      res.end(forwarded.text);
      return;
    }

    const result = await router.chat({
      combo: requested,
      body,
      keyMeta,
      attribution,
      region: requestedRegion,
      privacyTier: requestedTier,
      // I12: naming a model directly is a deliberate act, not auto-routing, so
      // an explicitly requested tos:avoid model is allowed through.
      allowAvoid: !configRef.combos[requested] && Boolean(configRef.models[requested]),
      onToken: stream ? onToken : undefined,
      onAttempt: (t) => {
        target = t;
      },
    });

    // B5.5: the call happened, so it counts against the run — before the
    // response is written, so a client cannot outrun the bound.
    if (tracker) {
      tracker.record({ tool: 'chat', input: { combo: requested, prompt: body?.messages?.at(-1)?.content ?? '' }, costUsd: result.meta?.costUsd ?? 0 });
    }

    if (stream) {
      const meta = result.meta;
      meta.handlerMs = Math.round((performance.now() - handlerStart) * 100) / 100;
      meta.overheadMs = Math.max(0, Math.round((meta.handlerMs - meta.latencyMs) * 100) / 100);
      res.write(
        sse({
          id: `chatcmpl-sui-${startedAt}`,
          object: 'chat.completion.chunk',
          created: Math.floor(startedAt / 1000),
          model: requested,
          choices: [{ index: 0, delta: {}, finish_reason: result.finishReason ?? 'stop' }],
          usage: {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
          },
          sui: provenance(meta),
        }),
      );
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const meta = result.meta;
    meta.handlerMs = Math.round((performance.now() - handlerStart) * 100) / 100;
    meta.overheadMs = Math.max(0, Math.round((meta.handlerMs - meta.latencyMs) * 100) / 100);
    res.setHeader('x-sui-handler-ms', String(meta.handlerMs));
    res.setHeader('x-sui-overhead-ms', String(meta.overheadMs));
    res.setHeader('x-sui-provider', meta.provider);
    res.setHeader('x-sui-model', meta.model);
    res.setHeader('x-sui-combo', meta.combo);
    res.setHeader('x-sui-verified', String(meta.verified));
    res.setHeader('x-sui-cached', String(meta.cached));
    if (meta.cacheKind) res.setHeader('x-sui-cache-kind', meta.cacheKind);
    res.setHeader('x-sui-cost-usd', String(meta.costUsd));
    res.setHeader('x-sui-latency-ms', String(meta.latencyMs));

    return sendJson(res, 200, {
      id: `chatcmpl-sui-${startedAt}`,
      object: 'chat.completion',
      created: Math.floor(startedAt / 1000),
      model: requested,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: result.finishReason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
      },
      sui: provenance(meta),
    });
  }

  return server;
}

/** The chip under every answer: who answered, was it real, was it cached, how fast. */
export function provenance(meta) {
  return {
    provider: meta.provider,
    providerName: meta.providerName,
    model: meta.model,
    modelId: meta.modelId,
    combo: meta.combo,
    arm: meta.arm,
    strategy: meta.strategy,
    verified: meta.verified,
    cached: meta.cached,
    cacheKind: meta.cacheKind ?? null,
    compression: meta.compression ?? null,
    verification: meta.verification ?? null,
    route: meta.route ?? null,
    latencyMs: meta.latencyMs,
    ttftMs: meta.ttftMs,
    costUsd: meta.costUsd,
    handlerMs: meta.handlerMs ?? null,
    overheadMs: meta.overheadMs ?? null,
    escalation: meta.escalation ?? null,
    attempts: meta.attempts ?? [],
  };
}

/** @param {any} config @param {boolean} all */
function modelList(config, all) {
  // `auto` is synthetic, so it is not in config.combos: list it first, because it
  // is the one a new caller should use.
  const auto = autoCombo(config);
  const combos = [
    ...(auto
      ? [
          {
            id: 'auto',
            object: 'model',
            owned_by: 'sui-router',
            label: auto.label,
            strategy: 'auto',
            targets: auto.targets.map((t) => (typeof t === 'string' ? t : t.model)),
            synthetic: true,
          },
        ]
      : []),
    ...Object.entries(config.combos).map(([id, c]) => ({
    id,
    object: 'model',
    owned_by: 'sui-router',
      label: /** @type {any} */ (c).label ?? id,
      strategy: /** @type {any} */ (c).strategy,
      targets: /** @type {any} */ (c).targets.map((t) => (typeof t === 'string' ? t : t.model)),
    })),
  ];
  if (!all) return combos;
  const models = Object.entries(config.models).map(([id, m]) => ({
    id,
    object: 'model',
    owned_by: /** @type {any} */ (m).provider,
    label: /** @type {any} */ (m).label ?? id,
    available: providerHasCredentials(config.providers[/** @type {any} */ (m).provider], config.env, config),
  }));
  return [...combos, ...models];
}

function statusPayload(config, ledger, breaker, cache, router, workers = null, planesInfo = null) {
  const agg = ledger.aggregate({ since: startOfToday() });
  const spent = ledger.todaySpendUsd();
  const daily = config.budgets.dailyUsd;

  const pool = Object.entries(config.models)
    .filter(([, m]) => providerHasCredentials(config.providers[/** @type {any} */ (m).provider], config.env, config))
    .map(([id, m]) => {
      const state = breaker.stateOf(id);
      return {
        modelId: id,
        label: /** @type {any} */ (m).label ?? id,
        provider: /** @type {any} */ (m).provider,
        quality: /** @type {any} */ (m).quality ?? null,
        tier: /** @type {any} */ (m).tier ?? 'paid',
        costPer1kIn: /** @type {any} */ (m).costPer1kIn ?? 0,
        costPer1kOut: /** @type {any} */ (m).costPer1kOut ?? 0,
        health: state.state,
        retryInMs: state.retryInMs,
        lastError: state.lastError,
        turnsToday: agg.byModel[id]?.turns ?? 0,
        costToday: agg.byModel[id]?.costUsd ?? 0,
        avgLatencyMs: agg.byModel[id]?.avgLatencyMs ?? 0,
      };
    });

  const unconfigured = Object.entries(config.models)
    .filter(([, m]) => !providerHasCredentials(config.providers[/** @type {any} */ (m).provider], config.env, config))
    .map(([id, m]) => ({ modelId: id, provider: /** @type {any} */ (m).provider, needsEnv: config.providers[/** @type {any} */ (m).provider]?.apiKeyEnv ?? null }));

  return {
    server: { host: config.server.host, port: config.server.port, uptimeSeconds: Math.round(process.uptime()) },
    // B5.7: which half of the split this is, and what it can reach
    planes: planesInfo,
    // B9.4: quota windows the router is currently honouring
    quotaWindows: router.quotaSnapshot?.() ?? [],
    // B6.4: what each provider does with what you send it, and which tiers it
    // clears — the answer a person needs before choosing a default tier.
    privacy: {
      defaultTier: config.privacy?.defaultTier ?? 'any',
      providers: Object.entries(config.providers ?? {}).map(([id, provider]) => ({
        id,
        retention: provider.privacy?.retention ?? 'unknown',
        trainsOnData: provider.privacy?.trainsOnData ?? null,
        tiers: {
          standard: providerMeetsPrivacyTier(provider, 'standard'),
          strict: providerMeetsPrivacyTier(provider, 'strict'),
        },
      })),
    },
    configPath: config.path,
    budget: {
      dailyUsd: daily,
      spentUsd: spent,
      pct: daily ? Math.min(100, Math.round((spent / Number(daily)) * 100)) : null,
      warnAtPct: config.budgets.warnAtPct,
    },
    pool,
    unconfigured,
    combos: Object.entries(config.combos).map(([id, c]) => ({
      id,
      label: /** @type {any} */ (c).label ?? id,
      strategy: /** @type {any} */ (c).strategy,
      targets: /** @type {any} */ (c).targets.map((t) => (typeof t === 'string' ? t : t.model)),
      turnsToday: agg.byCombo[id]?.turns ?? 0,
      costToday: agg.byCombo[id]?.costUsd ?? 0,
    })),
    metrics: agg,
    cache: cache.stats(),
    breakers: breaker.snapshot(),
    guardrails: config.guardrails,
    paidTiers: { enabled: config.paidTiers?.enabled === true },
    invariantWarnings: auditConfig(config).filter((a) => !a.ok),
    probes: workers?.snapshot?.().probes ?? [],
    promptUsage: ledger.promptUsage(20),
  };
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sinceParam(url) {
  const raw = url.searchParams.get('since');
  if (!raw) return startOfToday();
  if (raw === 'all') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : startOfToday();
}

/** @param {any} req @param {any} config */
/**
 * The console is admin surface: when SUI_ADMIN_TOKEN is set, every write and the
 * tenant list need it. Without one, it is loopback-only like the rest of /api.
 */
/**
 * The catalogue, joined to what this machine knows about it.
 *
 * Three sources, and they say different things: the seed is what the project
 * imported (an identity), the overlay is what a probe observed on this machine (a
 * route), and the prober's snapshot is what this process has seen since it
 * started. Joining them is the only way to answer "is this a route, and if not,
 * why not" without guessing.
 */
/** The catalogue as this machine knows it: the seed, with the probe overlay applied. */
function catalogueWithOverlay() {
  const overlay = readVerifiedOverlay([
    join(suiHome(process.env), 'catalog-verified.json'),
    join(HERE, '..', '..', '..', 'packages', 'catalog', 'verified.json'),
  ]);
  return applyVerified(loadCatalogue(), overlay);
}

function providerReport(config, workers) {
  const entries = catalogueWithOverlay();
  const probes = new Map((workers?.snapshot?.().probes ?? []).map((p) => [p.provider, p]));

  const combosFor = (modelIds) => {
    const ids = new Set(modelIds);
    return Object.entries(config.combos ?? {})
      .filter(([, combo]) => (combo.targets ?? []).some((t) => ids.has(typeof t === 'string' ? t : t.model)))
      .map(([id]) => id);
  };

  const providers = entries.map((entry) => {
    const configured = Object.entries(config.models ?? {})
      .filter(([, model]) => model.provider === entry.provider)
      .map(([id]) => id);
    const probe = probes.get(entry.provider) ?? null;

    return {
      provider: entry.provider,
      // the prober writes its history under the pool key, so the page needs it to
      // find this provider's durable samples
      poolKey: poolKey(entry),
      label: entry.label ?? entry.provider,
      // three states, and "identity" is the honest one for an entry with no
      // endpoint: it is a name we know about, not a route we can call
      state: entry.verified_at ? 'verified' : entry.base_url ? 'awaiting-probe' : 'identity',
      baseUrl: entry.base_url ?? null,
      auth: entry.auth ?? null,
      tos: entry.tos ?? null,
      capabilities: entry.capabilities ?? [],
      catalogueModels: entry.models ?? [],
      verifiedAt: entry.verified_at ?? null,
      probeModel: entry.probe_model ?? null,
      probe: probe
        ? {
            weather: probe.weather,
            status: probe.status,
            failures: probe.failures,
            lastProbeAt: probe.lastProbeAt,
            lastOkAt: probe.lastOkAt,
            history: (probe.history ?? []).slice(-12),
          }
        : null,
      configuredModels: configured,
      combos: combosFor(configured),
    };
  });

  const count = (state) => providers.filter((p) => p.state === state).length;
  return {
    summary: {
      total: providers.length,
      verified: count('verified'),
      awaitingProbe: count('awaiting-probe'),
      identities: count('identity'),
      routable: providers.filter((p) => p.combos.length).length,
    },
    providers,
  };
}

/**
 * How long a page-triggered probe may wait.
 *
 * The number comes from the request, so it is clamped: a caller that asks for an
 * hour holds a socket for an hour, and one click becomes a way to keep the
 * process busy. Exported because the alternative is a test that waits thirty
 * seconds to prove the ceiling.
 */
export function clampProbeTimeout(raw, fallbackMs = 8000) {
  const asked = Number(raw ?? fallbackMs);
  if (!Number.isFinite(asked)) return fallbackMs;
  return Math.min(30_000, Math.max(100, Math.round(asked)));
}

function requireAdmin(req, config, opts = {}) {
  const expected = config.env?.SUI_ADMIN_TOKEN ?? process.env.SUI_ADMIN_TOKEN;
  if (!expected) {
    // Reading the console from a gateway on the network is fine — it holds no
    // prompt text. *Changing* a cap is not: on a bind like 0.0.0.0 anyone who can
    // reach the port could raise their own limit, and a console that can raise a
    // cap is a console that can spend your money. Loopback stays open, because
    // there the only caller is the person at the keyboard.
    const host = String(config.server?.host ?? '127.0.0.1');
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
    if (opts.write && !loopback) {
      throw new SuiError(
        `Refusing to change a tenant on a gateway bound to ${host} with no admin token: anyone who can reach this port could raise a cap. ` +
          `Set SUI_ADMIN_TOKEN on the gateway and send it as x-sui-admin, or bind 127.0.0.1.`,
        { code: 'admin_required', status: 403 },
      );
    }
    return;
  }
  const presented = String(req.headers['x-sui-admin'] ?? req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (presented !== expected) {
    throw new SuiError('This endpoint needs the admin token (SUI_ADMIN_TOKEN).', { code: 'admin_required', status: 403 });
  }
}

/** A user agent is a label, not a fingerprint: keep the product, drop the rest. */
function shortAgent(agent) {
  if (!agent) return null;
  const first = String(agent).split(/[\s/]/)[0];
  return first ? first.slice(0, 40) : null;
}

function authorise(req, config) {
  const keys = config.apiKeys ?? [];
  const envKey = config.env?.SUI_API_KEY;
  if (!keys.length && !envKey) return null;

  const header = String(req.headers.authorization ?? '');
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-sui-key'] ?? '');
  if (!presented) {
    throw new SuiError('This gateway needs an API key. Send it as "Authorization: Bearer <key>".', {
      code: 'unauthorized',
      status: 401,
    });
  }
  const match = keys.find((k) => verifyApiKey(presented, k));
  if (match) return match;
  if (envKey && verifyApiKey(presented, { key: envKey })) {
    return { key_hash: hashApiKey(envKey), name: 'SUI_API_KEY', allowedCombos: null };
  }
  throw new SuiError('That API key is not recognised by this gateway.', { code: 'unauthorized', status: 401 });
}

function readDashboard() {
  try {
    return readFileSync(DASHBOARD, 'utf8');
  } catch {
    return '<!doctype html><meta charset="utf-8"><title>Sui</title><body style="font:16px system-ui;padding:2rem"><h1>Dashboard file missing</h1><p>Expected web/dashboard.html next to the server. Reinstall the package.</p></body>';
  }
}

/** @param {any} req */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > 20_000_000) {
        tooLarge = true;
        // Pause rather than destroy: destroying the socket here means the caller
        // sees ECONNRESET and never reads the 413 explaining why. The response is
        // sent first, and the socket closes with it.
        req.pause();
        reject(new SuiError('Request body is larger than 20 MB.', { code: 'payload_too_large', status: 413 }));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new SuiError('Request body is not valid JSON.', { code: 'bad_request', status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** @param {any} res @param {number} status @param {any} payload */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** @param {any} res @param {string} html */
function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/* ------------------------------------------------------- host allowlisting */

const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** @param {any} config */
function allowedHostNames(config) {
  return config.server?.allowedHosts?.length ? config.server.allowedHosts : DEFAULT_ALLOWED_HOSTS;
}

/**
 * @param {any} config
 * @param {string|undefined} hostHeader
 */
export function hostAllowed(config, hostHeader) {
  if (!hostHeader) return true; // HTTP/1.0 and some local clients omit it
  const host = String(hostHeader).toLowerCase();
  const withoutPort = host.replace(/:\d+$/, '');
  return allowedHostNames(config).some((allowed) => {
    const a = String(allowed).toLowerCase();
    return a === host || a === withoutPort;
  });
}
