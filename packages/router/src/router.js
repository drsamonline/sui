/**
 * The router.
 *
 * A request names a *combo* — a virtual model — and the router decides which
 * real provider answers it, in what order, and what to do when one of them is
 * resting, out of credit or over budget.
 *
 * Strategies:
 *   fallback  declared order, first healthy target wins
 *   weighted  one target picked by weight (A/B test), the rest as fallback
 *   cheapest  lowest blended cost among targets that clear the quality floor
 *   latency   fastest measured p50 among healthy targets
 *
 * Every attempt is written to the ledger, including failures, so "why did this
 * go to Gemini?" is answerable afterwards.
 */

import { ConfigError, ExhaustedError, ProviderError, SuiError } from '@sui/core';
import { estimatedCost, estimateTokens, providerHasCredentials, resolveCombo } from '@sui/core';
import { ResponseCache } from '@sui/telemetry';
import { RecallStore } from '@sui/compression';
import { createAdapter, displayName } from '@sui/providers';
import { checkPrompt, clampMaxTokens } from '@sui/guardrails';
import { applyStyle, choosePreset, chooseStyle, compress as compressText } from '@sui/compression';

/**
 * @typedef {{
 *   provider: string, providerName: string, model: string, modelId: string, combo: string,
 *   arm: string|null, cached: boolean, verified: boolean, latencyMs: number, ttftMs: number|null,
 *   costUsd: number, usage: {prompt_tokens: number, completion_tokens: number},
 *   strategy: string, attempts: Array<{modelId: string, provider: string, reason: string}>
 * }} TurnMeta
 */

export class Router {
  /**
   * @param {{
   *   config: any, ledger: any, breaker: any, cache: any,
   *   logger?: {debug: Function, info: Function, warn: Function},
   *   now?: () => number, random?: () => number
   * }} deps
   */
  constructor(deps) {
    this.config = deps.config;
    this.ledger = deps.ledger;
    this.breaker = deps.breaker;
    this.cache = deps.cache;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.logger = deps.logger ?? { debug() {}, info() {}, warn() {} };
    /** @type {Map<string, any>} */
    this.adapters = new Map();
  }

  /** @param {string} providerId */
  adapterFor(providerId) {
    let a = this.adapters.get(providerId);
    if (!a) {
      const provider = this.config.providers[providerId];
      if (!provider) {
        throw new ConfigError(`Model points at provider "${providerId}", which is not declared.`, {
          path: 'providers',
        });
      }
      a = createAdapter(providerId, provider, this.config.env);
      this.adapters.set(providerId, a);
    }
    return a;
  }

  /** Rebuild adapters after a config change. */
  refresh() {
    this.adapters.clear();
  }

  /**
   * Work out the attempt order for a combo, and why anything was left out.
   * Pure decision-making: no network, no side effects.
   *
   * Two invariants live here:
   *   I12  a provider marked tos:avoid is never auto-routed
   *   I14  if every target is ejected by a breaker, the request is still
   *        attempted against the unfiltered enabled list rather than refused
   *
   * @param {string} comboName
   * @param {{promptTokens?: number, keyMeta?: any, exclude?: string[], allowAvoid?: boolean}} [opts]
   */
  plan(comboName, opts = {}) {
    const combo = resolveCombo(this.config, comboName);
    const promptTokens = opts.promptTokens ?? 0;
    const exclude = new Set(opts.exclude ?? []);
    /** @type {Array<{modelId: string, provider: string, reason: string}>} */
    const skipped = [];
    const allowedModels = opts.keyMeta?.allowedModels ? new Set(opts.keyMeta.allowedModels) : null;

    const dailyBudget = this.config.budgets.dailyUsd;
    const spentToday = this.ledger.todaySpendUsd();
    const budgetGone = dailyBudget != null && spentToday >= Number(dailyBudget);

    /** @type {Array<any>} */
    const usable = [];
    /** @type {Array<any>} */
    const resting = [];

    for (const target of combo.targets) {
      const { modelId, model } = target;
      const providerId = model?.provider;
      const provider = this.config.providers[providerId];

      if (!model) {
        skipped.push({ modelId, provider: String(providerId ?? '?'), reason: 'not declared in models' });
        continue;
      }
      if (exclude.has(modelId)) {
        skipped.push({ modelId, provider: providerId, reason: 'excluded by policy' });
        continue;
      }
      if (allowedModels && !allowedModels.has(modelId)) {
        skipped.push({ modelId, provider: providerId, reason: 'not allowed for this API key' });
        continue;
      }
      if (provider?.tos === 'avoid' && !opts.allowAvoid) {
        skipped.push({ modelId, provider: providerId, reason: 'terms of service marked avoid (never auto-routed)' });
        continue;
      }
      if (!providerHasCredentials(provider, this.config.env, this.config)) {
        skipped.push({
          modelId,
          provider: providerId,
          reason: isPaid(provider) && this.config.paidTiers?.enabled !== true
            ? 'paid tier is closed (paid_tiers.enabled is false)'
            : provider?.apiKeyEnv
              ? `no API key set (${provider.apiKeyEnv})`
              : 'provider not configured',
        });
        continue;
      }
      // Money is checked before health: a resting provider that is also over
      // budget must not be woken up by the I14 escape hatch.
      if (budgetGone) {
        skipped.push({ modelId, provider: providerId, reason: 'daily budget reached' });
        continue;
      }
      const providerCap = this.config.budgets.perProvider?.[providerId];
      if (providerCap != null && this.ledger.providerSpendToday(providerId) >= Number(providerCap)) {
        skipped.push({ modelId, provider: providerId, reason: `provider budget reached ($${providerCap}/day)` });
        continue;
      }
      if (combo.strategy === 'cheapest' && Number(model.quality ?? 5) < Number(combo.minQuality ?? 1)) {
        skipped.push({
          modelId,
          provider: providerId,
          reason: `quality ${model.quality ?? '?'} is below the floor of ${combo.minQuality}`,
        });
        continue;
      }
      if (combo.maxCostPer1k != null) {
        const blended = Number(model.costPer1kIn ?? 0) + Number(model.costPer1kOut ?? 0);
        if (blended > Number(combo.maxCostPer1k)) {
          skipped.push({ modelId, provider: providerId, reason: `costs more than the $${combo.maxCostPer1k}/1k cap` });
          continue;
        }
      }

      const entry = { ...target, providerId, provider, estimate: this.#estimateCost(model, promptTokens) };

      if (!this.breaker.canAttempt(modelId)) {
        // I14: not a skip. Held back as a last resort so a health blip cannot
        // become a total outage.
        resting.push(entry);
        const st = this.breaker.stateOf(modelId);
        skipped.push({
          modelId,
          provider: providerId,
          reason: `resting after a failure (retrying in ${Math.ceil(st.retryInMs / 1000)}s) — held back, not skipped`,
        });
        continue;
      }

      usable.push(entry);
    }

    let ordered = usable;
    if (combo.strategy === 'cheapest') {
      ordered = [...usable].sort((a, b) => a.estimate - b.estimate || Number(b.model.quality ?? 0) - Number(a.model.quality ?? 0));
    } else if (combo.strategy === 'latency') {
      ordered = [...usable].sort((a, b) => this.#p50(a.modelId) - this.#p50(b.modelId));
    } else if (combo.strategy === 'weighted' && usable.length) {
      const primary = pickWeighted(usable, this.random);
      ordered = [primary, ...usable.filter((t) => t.modelId !== primary.modelId).sort((a, b) => b.weight - a.weight)];
    }

    return { combo, ordered, resting, skipped, spentToday, dailyBudget };
  }

  /**
   * Compress everything except the last user message.
   *
   * The preset is chosen from the provider budget as a quota proxy until real
   * quota telemetry lands (B2.3 follow-on): a provider at 90% of its daily cap
   * is a provider whose remaining tokens are worth more.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {string} comboName
   */
  #shapeContext(messages, comboName) {
    const settings = this.config.compression ?? {};
    const style = settings.outputStyle ?? 'off';
    const wantsStyle = style !== 'off';

    if (!settings.enabled && !wantsStyle) return { messages, meta: null };

    const lastUserIndex = settings.keepLastUserMessage
      ? messages.map((m) => m.role).lastIndexOf('user')
      : -1;

    let preset = settings.preset;
    let presetReason = null;
    if (preset === 'auto') {
      const quota = this.#quotaFraction(comboName);
      const chosen = choosePreset({ fraction: quota });
      preset = chosen.preset;
      presetReason = chosen.reason;
    }

    const store = this.recallStore ?? (this.recallStore = new RecallStore({ secret: this.config.recallSecret }));

    let originalChars = 0;
    let compressedChars = 0;
    const steps = [];
    const next = (settings.enabled ? messages : messages).map((message, index) => {
      if (index === lastUserIndex) return message;
      if (typeof message.content !== 'string' || message.content.length < settings.minChars) return message;
      const result = compressText(message.content, { preset, store });
      originalChars += result.originalChars;
      compressedChars += result.compressedChars;
      for (const step of result.steps) if (step.droppedChars) steps.push({ ...step, message: index });
      return { ...message, content: result.text };
    });

    // B4.4: the output axis. 'auto' follows the same quota reading as the preset.
    let resolvedStyle = style;
    let styleReason = null;
    if (style === 'auto') {
      const chosen = chooseStyle({ fraction: this.#quotaFraction(comboName), taskHint: messages[messages.length - 1]?.content });
      resolvedStyle = chosen.style;
      styleReason = chosen.reason;
    }
    const styled = resolvedStyle !== 'off' ? applyStyle(next, resolvedStyle) : next;

    const meta = {
      preset: settings.enabled ? preset : null,
      reason: presetReason,
      style: resolvedStyle === 'off' ? null : resolvedStyle,
      styleReason,
      ratio: originalChars ? Math.round(((originalChars - compressedChars) / originalChars) * 1000) / 1000 : 0,
      savedChars: Math.max(0, originalChars - compressedChars),
      steps,
    };

    if (!steps.length && resolvedStyle === 'off') return { messages: next, meta: null };
    return { messages: styled, meta };
  }

  /** 1 = plenty of budget left, 0 = none. Used to pick a compression preset. */
  #quotaFraction(comboName) {
    const combo = this.config.combos?.[comboName];
    const providerId = combo ? this.config.models?.[combo.targets?.[0]]?.provider : null;
    const cap = providerId ? this.config.budgets?.perProvider?.[providerId] : null;
    if (cap == null) {
      const daily = this.config.budgets?.dailyUsd;
      if (daily == null) return 1;
      return Math.max(0, 1 - this.ledger.todaySpendUsd() / Number(daily));
    }
    return Math.max(0, 1 - this.ledger.providerSpendToday(providerId) / Number(cap));
  }

  #estimateCost(model, promptTokens) {
    const blended = (Number(model.costPer1kIn ?? 0) + Number(model.costPer1kOut ?? 0)) / 2;
    return (blended * Math.max(promptTokens, 1)) / 1000;
  }

  #p50(modelId) {
    const rows = this.ledger.entries().filter((r) => r.modelId === modelId && r.ok);
    if (!rows.length) return Number.POSITIVE_INFINITY;
    const sorted = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * Run a chat turn.
   *
   * @param {{
   *   combo: string, body: any, keyMeta?: any,
   *   onToken?: (delta: string) => void, now?: () => number
   * }} input
   * @returns {Promise<{text: string, usage: {prompt_tokens: number, completion_tokens: number}, finishReason: string|null, meta: TurnMeta}>}
   */
  async chat(input) {
    const started = this.now();
    const body = input.body ?? {};
    const comboName = input.combo;
    const messages = normaliseMessages(body.messages);
    const promptText = messages.map((m) => m.content).join('\n');
    const streamed = Boolean(body.stream);

    checkPrompt({ messages, guardrails: this.config.guardrails });

    // B4.1/B4.4: compress the older context, never the question being asked,
    // then shape the output axis if it is on.
    const compressed = this.#shapeContext(messages, comboName);
    const effectiveMessages = compressed.messages;
    const promptTokens = estimateTokens(effectiveMessages.map((m) => m.content).join('\n'));

    const { combo, ordered, resting, skipped } = this.plan(comboName, {
      promptTokens,
      keyMeta: input.keyMeta,
      allowAvoid: Boolean(input.allowAvoid),
    });

    const cacheKey = this.cache?.enabled && !streamed ? ResponseCache.key({ ...body, combo: comboName }) : null;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey, promptText);
      if (hit) {
        const meta = {
          ...hit.value.meta,
          cached: true,
          cacheKind: hit.kind,
          latencyMs: this.now() - started,
          ttftMs: 0,
          attempts: [],
        };
        this.ledger.record({
          provider: meta.provider,
          model: meta.model,
          modelId: meta.modelId,
          combo: comboName,
          arm: meta.arm,
          ok: true,
          promptTokens: hit.value.usage.prompt_tokens,
          completionTokens: hit.value.usage.completion_tokens,
          costUsd: hit.value.meta.costUsd,
          latencyMs: meta.latencyMs,
          ttftMs: 0,
          cached: true,
          verified: meta.verified,
          promptText,
          streamed: false,
        });
        return { text: hit.value.text, usage: hit.value.usage, finishReason: hit.value.finishReason, meta };
      }
    }

    if (!ordered.length && !resting.length) {
      throw exhausted(comboName, skipped, this.config);
    }

    /** @type {Array<{modelId: string, provider: string, reason: string}>} */
    const attempts = [];
    let lastError = null;
    let usedResting = false;

    // Healthy targets first; the held-back ones only if every healthy target
    // failed. This is the I14 escape hatch, and it is recorded when used.
    const queue = [...ordered, ...resting.map((t) => ({ ...t, restingFallback: true }))];

    for (const target of queue) {
      const { modelId, model, providerId, arm } = target;
      const adapter = this.adapterFor(providerId);
      const emptyRetryAllowed = this.config.streaming?.emptyTurnRetry !== false;
      let retriedEmpty = false;

      // B3.3: an empty turn is a failed turn. Some free tiers answer a 200 with
      // nothing in it when they are throttling — retry the same target once,
      // then move on, rather than handing the user a blank reply.
      for (;;) {
        const attemptStart = this.now();
        let ttft = null;
        let committed = false;

        /** @type {(delta: string) => void} */
        const emit = (delta) => {
          if (!committed) {
            committed = true;
            ttft = this.now() - attemptStart;
          }
          input.onToken?.(delta);
        };

        try {
          input.onAttempt?.({ modelId, providerId, providerName: adapter.name, model: model.model, arm: arm ?? null });
          const result = await adapter.chat(
            {
              model: model.model,
              messages: effectiveMessages,
              stream: streamed,
              temperature: body.temperature,
              max_tokens: clampMaxTokens(body.max_tokens, this.config.guardrails),
              top_p: body.top_p,
              stop: body.stop,
            },
            { onToken: streamed ? emit : undefined },
          );

          const latencyMs = this.now() - attemptStart;
          const isEmpty = !committed && String(result.text ?? '').trim().length === 0;

          if (isEmpty && emptyRetryAllowed && !retriedEmpty) {
            retriedEmpty = true;
            attempts.push({ modelId, provider: providerId, reason: 'empty turn — retried once on the same target' });
            this.ledger.record({
              provider: providerId,
              model: model.model,
              modelId,
              combo: comboName,
              arm: arm ?? null,
              ok: false,
              error: 'empty_turn',
              promptTokens: result.usage?.prompt_tokens ?? promptTokens,
              completionTokens: 0,
              costUsd: 0,
              latencyMs,
              ttftMs: ttft,
              cached: false,
              verified: false,
              promptText,
              streamed,
            });
            this.logger.warn(`${displayName(providerId)} (${modelId}) returned an empty turn — retrying once`);
            continue;
          }

          if (isEmpty) {
            // Still empty after the retry: record it and try the next target.
            attempts.push({ modelId, provider: providerId, reason: 'empty turn (no retry left)' });
            this.ledger.record({
              provider: providerId,
              model: model.model,
              modelId,
              combo: comboName,
              arm: arm ?? null,
              ok: false,
              error: 'empty_turn',
              promptTokens: result.usage?.prompt_tokens ?? promptTokens,
              completionTokens: 0,
              costUsd: 0,
              latencyMs,
              ttftMs: ttft,
              cached: false,
              verified: false,
              promptText,
              streamed,
            });
            break;
          }

          const costUsd = estimatedCost(model, result.usage.prompt_tokens, result.usage.completion_tokens);
          const verified = adapter.type !== 'mock';

          // B7.2: what the compression saved, valued at this model's input price.
          const savedTokens = Math.ceil((compressed.meta?.savedChars ?? 0) / 4);
          const savedUsd = savedTokens ? Math.round((Number(model.costPer1kIn ?? 0) * savedTokens) / 1000 * 1e6) / 1e6 : 0;

          this.breaker.recordSuccess(modelId);
          if (target.restingFallback) usedResting = true;

          /** @type {TurnMeta} */
          const meta = {
            provider: providerId,
            providerName: adapter.name,
            model: model.model,
            modelId,
            combo: comboName,
            arm: arm ?? null,
            cached: false,
            cacheKind: null,
            verified,
            latencyMs,
            ttftMs: streamed ? ttft : null,
            costUsd,
            usage: result.usage,
            strategy: combo.strategy,
            attempts,
            escalation: usedResting ? 'I14 — every healthy target failed, a resting one was tried' : null,
            compression: compressed.meta,
            savedUsd,
          };

          this.ledger.record({
            provider: providerId,
            model: model.model,
            modelId,
            combo: comboName,
            arm: arm ?? null,
            ok: true,
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            costUsd,
            latencyMs,
            ttftMs: streamed ? ttft : null,
            cached: false,
            verified,
            promptText,
            streamed,
            compressionSavedTokens: savedTokens,
            compressionSavedUsd: savedUsd,
            compressionPreset: compressed.meta?.preset ?? null,
          });

          if (cacheKey) {
            this.cache.set(
              cacheKey,
              { text: result.text, usage: result.usage, finishReason: result.finishReason, meta },
              { promptText },
            );
          }

          return { text: result.text, usage: result.usage, finishReason: result.finishReason, meta };
        } catch (err) {
          const e = /** @type {any} */ (err);
          const latencyMs = this.now() - attemptStart;

          // I13: only 5xx and transport failures trip the breaker. A 401 or a 404
          // is a fact about the key or the model name, not a health signal, and
          // tripping on it would hide a config bug behind a cooldown.
          if (tripsBreaker(e)) this.breaker.recordFailure(modelId, e.message);

          attempts.push({ modelId, provider: providerId, reason: e.message ?? String(err) });
          lastError = e;

          this.ledger.record({
            provider: providerId,
            model: model.model,
            modelId,
            combo: comboName,
            arm: arm ?? null,
            ok: false,
            error: e.message ?? String(err),
            promptTokens,
            completionTokens: 0,
            costUsd: 0,
            latencyMs,
            ttftMs: ttft,
            cached: false,
            verified: false,
            promptText,
            streamed,
          });

        this.logger.warn(`${displayName(providerId)} (${modelId}) failed: ${e.message}`);

        if (committed) {
          // Tokens already went to the client. Switching provider now would
          // splice two different answers together, so stop and say so.
          throw new SuiError(
            `${displayName(providerId)} dropped the connection mid-answer. Nothing was retried because part of the reply had already been sent.`,
            { code: 'stream_interrupted', status: 502, retryable: false, detail: e.message },
          );
        }
        // A non-retryable provider error (401, 404, a malformed request) is a
        // fact about that provider, not a reason to abandon the whole combo:
        // the next target is a different provider with a different key.
        if (!(e instanceof ProviderError)) throw e;
        break; // this target is done; the outer loop moves to the next one
      }
    }
  }

    const err = exhausted(comboName, skipped, this.config, attempts);
    if (lastError && !(lastError instanceof ProviderError)) throw lastError;
    throw err;
  }
}

/**
 * Build the plain-language "nothing left" error. This is the message a user
 * actually reads, so it says what is resting, why, and what to do next.
 */
function exhausted(comboName, skipped, config, attempts = []) {
  const parts = [];
  for (const s of skipped) parts.push(`${s.modelId} — ${s.reason}`);
  for (const a of attempts) parts.push(`${a.modelId} — tried and failed: ${a.reason}`);
  const tried = attempts.length ? `Tried ${attempts.length}, all failed. ` : '';
  return new ExhaustedError(
    `No model could answer "${comboName}" right now. ${tried}${parts.length ? `Details: ${parts.join('; ')}.` : ''} Add a provider key, wait for the cooldown, or raise the daily budget.`,
    { attempts: [...attempts, ...skipped.map((s) => ({ model: s.modelId, reason: s.reason }))] },
  );
}

/** @param {any[]} messages */
function normaliseMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new SuiError('messages must be a non-empty array.', { code: 'bad_request', status: 400 });
  }
  return messages.map((m) => ({
    role: m.role ?? 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
  }));
}

/** @param {any[]} items @param {() => number} random */
function pickWeighted(items, random) {
  const total = items.reduce((a, i) => a + (Number(i.weight) || 1), 0);
  let r = random() * total;
  for (const item of items) {
    r -= Number(item.weight) || 1;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/** Is this provider gated behind the paid air-gap? */
function isPaid(provider) {
  return Boolean(provider && (provider.tier === 'paid' || provider.paid === true));
}

/**
 * I13 — does this failure say something about the provider's health?
 * Yes for 5xx, timeouts and transport errors. No for 400/401/403/404/422/429.
 * @param {any} err
 */
export function tripsBreaker(err) {
  if (!err) return false;
  const code = String(err.code ?? '');
  if (code === 'provider_timeout' || code === 'provider_unreachable') return true;
  const status = Number(err.status ?? 0);
  return status >= 500;
}
