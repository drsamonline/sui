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
 * B6.3 — dual-channel inspection.
 *
 * A prompt is not the only way instructions arrive. A tool *definition* is
 * text the model will read, and a tool *result* is text an attacker may control
 * completely. Inspecting only the prompt is inspecting the wrong channel.
 *
 * Modes: 'off' (default), 'warn' (report, allow), 'block' (refuse on a high finding).
 */

/** Phrases that make no sense in a tool description unless someone is attacking. */
const INJECTION_MARKERS = [
  'ignore previous',
  'ignore all previous',
  'disregard your',
  'you must always',
  'do not tell the user',
  'system prompt',
  'new instructions',
  'reveal your',
  'print your instructions',
  'exfiltrate',
  'send the contents',
];

const SUSPICIOUS_TOOL_CHARS = /[\u200b-\u200f\u202a-\u202e\ufeff]/; // zero-width and bidi controls

/**
 * @param {{messages?: Array<any>, tools?: Array<any>, guardrails?: any}} input
 * @returns {{findings: Array<{channel: string, where: string, signal: string, severity: 'high'|'low', detail: string}>, mode: string, blocked: boolean}}
 */
export function inspectToolChannel(input) {
  const mode = input.guardrails?.inspectToolChannel ?? 'off';
  /** @type {Array<{channel: string, where: string, signal: string, severity: 'high'|'low', detail: string}>} */
  const findings = [];

  if (mode === 'off') return { findings, mode, blocked: false };

  const maxToolResultChars = Number(input.guardrails?.maxToolResultChars ?? 20000);

  // ---- channel 1: the tool definitions the model will read -----------------
  for (const [index, tool] of (input.tools ?? []).entries()) {
    const fn = tool?.function ?? tool ?? {};
    const name = fn.name ?? `tools[${index}]`;
    const description = String(fn.description ?? '');
    const params = JSON.stringify(fn.parameters ?? {});
    const haystack = `${description} ${params}`.toLowerCase();

    for (const marker of INJECTION_MARKERS) {
      if (haystack.includes(marker)) {
        findings.push({
          channel: 'tool_definition',
          where: name,
          signal: 'injection_marker',
          severity: 'high',
          detail: `the description of "${name}" contains "${marker}"`,
        });
        break;
      }
    }
    if (SUSPICIOUS_TOOL_CHARS.test(`${description}${params}`)) {
      findings.push({
        channel: 'tool_definition',
        where: name,
        signal: 'hidden_characters',
        severity: 'high',
        detail: `"${name}" carries zero-width or bidi control characters`,
      });
    }
  }

  // ---- channel 2: tool results, which an attacker may control entirely -----
  for (const [index, message] of (input.messages ?? []).entries()) {
    const isToolResult = message?.role === 'tool' || message?.role === 'function';
    if (!isToolResult) continue;

    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    const lower = content.toLowerCase();

    for (const marker of INJECTION_MARKERS) {
      if (lower.includes(marker)) {
        findings.push({
          channel: 'tool_result',
          where: `messages[${index}]`,
          signal: 'injection_marker',
          severity: 'high',
          detail: `a tool result contains "${marker}"`,
        });
        break;
      }
    }
    if (content.length > maxToolResultChars) {
      findings.push({
        channel: 'tool_result',
        where: `messages[${index}]`,
        signal: 'oversized',
        severity: 'low',
        detail: `a tool result is ${content.length} characters (limit ${maxToolResultChars})`,
      });
    }
  }

  const high = findings.filter((f) => f.severity === 'high');
  return { findings, mode, blocked: mode === 'block' && high.length > 0 };
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
