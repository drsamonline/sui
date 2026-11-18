/**
 * The tools this MCP server advertises.
 *
 * Descriptions are written for a model to read: what it does, when to use it,
 * and what it returns. Every tool returns MCP content blocks, and every result
 * carries the provenance the gateway already produces — an agent should be able
 * to say who answered without a second call.
 */

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

export const TOOLS = [
  {
    name: 'sui_chat',
    description:
      'Send a prompt through the gateway and get an answer. Use a combo name (a virtual model such as "chat-default") or a model id. Returns the answer plus provenance: provider, model, whether the answer was verified, latency, and cost.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user message.' },
        combo: { type: 'string', description: 'Combo or model id. Defaults to the first combo in the config.' },
        system: { type: 'string', description: 'Optional system instruction.' },
        max_tokens: { type: 'integer', minimum: 1, description: 'Cap on the answer length.' },
        privacy_tier: { type: 'string', enum: ['any', 'standard', 'strict'], description: 'How strict the provider policy must be.' },
        region: { type: 'string', enum: ['any', 'eu', 'us', 'in', 'uk', 'apac'], description: 'Where the provider must process the data.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'sui_models',
    description:
      'List the combos (virtual models) this gateway answers to, their strategy, their targets, and which targets are currently reachable. Call this before sui_chat if you do not know the combo names.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sui_explain',
    description:
      'Explain why a route would go where it goes, without sending a request. Returns sentences naming the strategy, the order, and every target that was skipped and why.',
    inputSchema: {
      type: 'object',
      properties: { combo: { type: 'string', description: 'The combo to explain. Defaults to the first combo.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'sui_cost',
    description: 'Report what the gateway has spent today, broken down by provider and by combo, with the savings from cache hits and compression.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sui_compress',
    description:
      'Show what a compression preset would do to a prompt: the ratio, the engines that ran, and whether code, URLs and JSON survived. Useful before enabling compression for real traffic.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The prompt to compress.' },
        preset: { type: 'string', enum: ['lite', 'standard', 'aggressive', 'ultra'], description: 'Defaults to standard.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'sui_status',
    description: 'Report gateway health: budget, pool health, breaker states, quota windows and the privacy posture of each provider.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/**
 * @param {string} name
 * @param {any} args
 * @param {any} gateway
 */
export async function callTool(name, args, gateway) {
  const { router, config, ledger } = gateway;

  switch (name) {
    case 'sui_chat': {
      const prompt = String(args?.prompt ?? '').trim();
      if (!prompt) return { content: text('sui_chat needs a prompt.'), isError: true };

      const combo = String(args.combo ?? Object.keys(config.combos)[0] ?? '');
      const messages = [];
      if (args.system) messages.push({ role: 'system', content: String(args.system) });
      messages.push({ role: 'user', content: prompt });

      try {
        const result = await router.chat({
          combo,
          body: { messages, max_tokens: args.max_tokens },
          privacyTier: args.privacy_tier,
          region: args.region,
          attribution: { user: 'mcp', tool: 'mcp-client' },
        });
        return {
          content: text(result.text),
          structuredContent: {
            provider: result.meta.provider,
            model: result.meta.modelId,
            combo,
            verified: result.meta.verified,
            cached: result.meta.cached,
            latencyMs: result.meta.latencyMs,
            costUsd: result.meta.costUsd,
            confidence: result.meta.verification?.confidence ?? null,
          },
        };
      } catch (err) {
        // A gateway failure is a tool error with the gateway's own sentence,
        // which already names the fix.
        return { content: text(/** @type {any} */ (err)?.message ?? String(err)), isError: true };
      }
    }

    case 'sui_models': {
      const combos = Object.entries(config.combos).map(([id, combo]) => {
        const plan = router.plan(id, {});
        return {
          id,
          label: combo.label ?? id,
          strategy: combo.strategy,
          reachable: plan.ordered.map((t) => t.modelId),
          resting: plan.resting.map((t) => t.modelId),
          skipped: plan.skipped.length,
        };
      });
      return { content: text(combos), structuredContent: { combos } };
    }

    case 'sui_explain': {
      const { explainPlan } = await import('@drsamonline/router');
      const combo = String(args?.combo ?? Object.keys(config.combos)[0] ?? '');
      const plan = router.plan(combo, {});
      const lines = explainPlan(plan);
      return { content: text(lines.join('\n')), structuredContent: { combo, lines } };
    }

    case 'sui_cost': {
      const agg = ledger.aggregate({ since: 0 });
      const summary = {
        spentUsd: agg.totals.costUsd,
        turns: agg.totals.turns,
        failed: agg.totals.failed,
        savedUsd: agg.totals.savings?.totalUsd ?? 0,
        tokensSaved: agg.totals.savings?.tokensSaved ?? 0,
        byProvider: Object.fromEntries(Object.entries(agg.byProvider).map(([k, v]) => [k, { turns: v.turns, costUsd: Math.round(v.costUsd * 1e6) / 1e6 }])),
        byCombo: Object.fromEntries(Object.entries(agg.byCombo).map(([k, v]) => [k, { turns: v.turns, costUsd: Math.round(v.costUsd * 1e6) / 1e6 }])),
      };
      return { content: text(summary), structuredContent: summary };
    }

    case 'sui_compress': {
      const { compress } = await import('@drsamonline/compression');
      const body = String(args?.text ?? '');
      if (!body.trim()) return { content: text('sui_compress needs some text.'), isError: true };
      const result = compress(body, { preset: args?.preset ?? 'standard' });
      const summary = {
        preset: result.preset,
        originalChars: result.originalChars,
        compressedChars: result.compressedChars,
        ratio: result.ratio,
        skipped: result.skipped,
        steps: result.steps,
        text: result.text,
      };
      return { content: text(summary), structuredContent: summary };
    }

    case 'sui_status': {
      const status = {
        budget: { dailyUsd: config.budgets.dailyUsd, spentUsd: Math.round(ledger.todaySpendUsd() * 1e6) / 1e6 },
        quotaWindows: router.quotaSnapshot?.() ?? [],
        breakers: router.breaker.snapshot(),
        privacy: {
          defaultTier: config.privacy?.defaultTier ?? 'any',
          region: config.privacy?.region ?? 'any',
          providers: Object.entries(config.providers).map(([id, p]) => ({ id, retention: p.privacy?.retention ?? 'unknown', region: p.region ?? 'unknown' })),
        },
      };
      return { content: text(status), structuredContent: status };
    }

    default:
      return { content: text(`No tool called "${name}".`), isError: true };
  }
}
