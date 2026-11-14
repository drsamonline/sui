/**
 * @sui/router/explain — B7.4, explain-my-route in plain language.
 *
 * A route decision is only trustworthy if it can be narrated. These functions
 * turn the plan (a pure data structure) and a turn's meta into sentences a person
 * can read, without a second query and without storing anything extra.
 */

/**
 * @param {{combo: any, ordered: any[], resting: any[], skipped: any[]}} plan
 * @returns {string[]}
 */
export function explainPlan(plan) {
  const lines = [];
  const combo = plan.combo;
  lines.push(`"${combo.name}" is a ${combo.strategy} route with ${combo.targets.length} target${combo.targets.length === 1 ? '' : 's'}.`);

  if (plan.ordered?.length) {
    const names = plan.ordered.map((t) => t.modelId);
    lines.push(`It would try ${names.join(' → ')}.`);
    if (combo.strategy === 'cheapest') lines.push('Targets are ordered by blended cost, after the quality floor.');
    if (combo.strategy === 'weighted') lines.push('The first target is picked by weight; the rest are fallbacks in weight order.');
    if (combo.strategy === 'latency') lines.push('Targets are ordered by measured p50 from the ledger.');
    if (plan.learned) {
      lines.push('Fallback learning is on for this combo: targets with enough recent samples are ordered by success rate, then latency, and the declared order breaks ties.');
    }
  } else {
    lines.push('No target is available right now.');
  }

  for (const skip of plan.skipped ?? []) {
    lines.push(`Skipped ${skip.modelId}: ${skip.reason}.`);
  }
  for (const resting of plan.resting ?? []) {
    lines.push(`Held back ${resting.modelId}: its breaker is open, so it is only tried if everything else fails.`);
  }
  return lines;
}

/**
 * @param {any} meta a completed turn's meta
 * @returns {string[]}
 */
export function explainTurn(meta) {
  if (!meta) return ['No turn to explain.'];
  const lines = [];
  lines.push(`Answered by ${meta.modelId} (${meta.providerName ?? meta.provider}) in ${meta.latencyMs} ms${meta.cached ? ', from cache' : ''}.`);

  for (const attempt of meta.attempts ?? []) {
    lines.push(`${attempt.modelId} did not answer: ${attempt.reason}.`);
  }
  if (meta.escalation) lines.push(meta.escalation);

  if (meta.compression?.preset || meta.compression?.style) {
    const bits = [];
    if (meta.compression.preset) bits.push(`compression ${meta.compression.preset} (${Math.round((meta.compression.ratio ?? 0) * 100)}% smaller)`);
    if (meta.compression.style) bits.push(`output style ${meta.compression.style}`);
    lines.push(`Shaped the request: ${bits.join(', ')}.`);
  }
  if (meta.verification) {
    lines.push(
      meta.verification.verified
        ? `Confidence ${meta.verification.confidence} clears the ${meta.verification.threshold} threshold.`
        : `Confidence ${meta.verification.confidence} is below ${meta.verification.threshold}: ${(meta.verification.reasons ?? []).map((r) => r.detail).join('; ') || 'no detail'}. Treated as unverified.`,
    );
  }
  if (meta.promptCache) {
    lines.push(meta.promptCache.hint ? `Prompt cache: ${meta.promptCache.hint}.` : `Prompt cache unavailable: ${meta.promptCache.unsupported}.`);
    if (meta.promptCache.volatile?.length) {
      lines.push(`The prefix carries ${meta.promptCache.volatile.map((v) => v.name).join(', ')}, which breaks provider caching.`);
    }
  }
  return lines;
}
