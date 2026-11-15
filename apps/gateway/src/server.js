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
import { checkToggle, sanitizeConfig, providerHasCredentials, providerMeetsPrivacyTier, verifyApiKey, hashApiKey, INVARIANTS, auditConfig, BUDGETS, PRIVACY_TIERS, REGIONS, tenantSnapshot, tenantSummary } from '@sui/core';
import { SuiError } from '@sui/core';
import { explainPlan } from '@sui/router';
import { PRESETS, compress as compressText } from '@sui/compression';
import { RateLimiter, checkKeyBudget } from './limits.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, '..', '..', 'dashboard', 'web', 'dashboard.html');

/**
 * @param {{router: any, config: any, ledger: any, breaker: any, cache: any, logger?: any}} deps
 */
export function createSuiServer(deps) {
  const { router, config, ledger, breaker, cache, workers, canary } = deps;
  const logger = deps.logger ?? { info() {}, warn() {}, debug() {} };
  const limiter = deps.limiter ?? new RateLimiter();
  let configRef = config;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Local tools (Cline, Continue, a browser tab) call this from other origins.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-sui-key');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
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
      if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
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
        return sendJson(res, 200, statusPayload(configRef, ledger, breaker, cache, router, workers));
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
        const reportPath =
          process.env.SUI_EVAL_REPORT ??
          join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'evals', 'last-report.json');
        if (!existsSync(reportPath)) {
          return sendJson(res, 200, {
            available: false,
            message: 'No eval has been run here yet. Run `npm run eval` or `npm run eval:self`.',
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
        requireAdmin(req, configRef);
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
      const status = e instanceof SuiError ? e.status : 500;
      const payload = e instanceof SuiError ? e.toJSON() : {
        error: { message: 'Something went wrong inside the gateway. The details are in the server log.', type: 'internal_error' },
      };
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

    const requested = body.model ?? Object.keys(configRef.combos)[0];
    if (!configRef.combos[requested] && !configRef.models[requested]) {
      throw new SuiError(
        `"${requested}" is not a combo or model this gateway knows. Call GET /v1/models for the list.`,
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
  const combos = Object.entries(config.combos).map(([id, c]) => ({
    id,
    object: 'model',
    owned_by: 'sui-router',
    label: /** @type {any} */ (c).label ?? id,
    strategy: /** @type {any} */ (c).strategy,
    targets: /** @type {any} */ (c).targets.map((t) => (typeof t === 'string' ? t : t.model)),
  }));
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

function statusPayload(config, ledger, breaker, cache, router, workers = null) {
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
function requireAdmin(req, config) {
  const expected = config.env?.SUI_ADMIN_TOKEN ?? process.env.SUI_ADMIN_TOKEN;
  if (!expected) return;
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
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 20_000_000) {
        reject(new SuiError('Request body is larger than 20 MB.', { code: 'payload_too_large', status: 413 }));
        req.destroy();
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
