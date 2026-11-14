/**
 * @sui/guardrails — the checks that run before a provider is called.
 *
 * Deliberately small and pure: prompt size, blocked patterns, output clamp.
 * This is a starter set, not a governance product (see SECURITY.md).
 */

import { SuiError } from '@sui/core';

/**
 * @param {{messages: Array<{role: string, content: string}>, guardrails: any}} input
 * @returns {{ok: true, promptText: string, chars: number}}
 */
export function checkPrompt(input) {
  const guardrails = input.guardrails ?? {};
  const promptText = input.messages.map((m) => m.content).join('\n');

  const maxChars = Number(guardrails.maxInputChars ?? 0);
  if (maxChars && promptText.length > maxChars) {
    throw new SuiError(
      `That prompt is ${promptText.length.toLocaleString('en-IN')} characters; this gateway allows ${maxChars.toLocaleString('en-IN')}.`,
      { code: 'input_too_large', status: 413 },
    );
  }

  for (const pattern of guardrails.blockPatterns ?? []) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue; // a broken pattern is a config bug, not a request failure
    }
    if (re.test(promptText)) {
      throw new SuiError('That prompt matched a blocked pattern in your guardrail policy.', {
        code: 'blocked_by_guardrail',
        status: 400,
        detail: `pattern: ${pattern}`,
      });
    }
  }

  return { ok: true, promptText, chars: promptText.length };
}

/**
 * The request's own max_tokens, clamped by policy. Whichever is smaller wins.
 * @param {any} requested
 * @param {any} guardrails
 */
export function clampMaxTokens(requested, guardrails) {
  const policy = Number(guardrails?.maxOutputTokens ?? 4096);
  const asked = Number(requested ?? policy);
  return Math.max(1, Math.min(asked, policy));
}
