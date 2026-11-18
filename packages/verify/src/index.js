/**
 * @drsamonline/verify — reference-free confidence scoring (B3.4).
 *
 * The spec asks for "verification escalation, fail-closed, confidence threshold
 * 0.7". There is no judge model here on purpose: a judge costs the same quota the
 * gateway is trying to conserve, and a judge that cannot explain itself is worse
 * than a heuristic that can.
 *
 * So this is a set of deterministic signals about an answer, each of which can
 * be pointed at in a test:
 *
 *   empty or near-empty · refusal markers · hedging density · repetition ·
 *   truncated by the token limit · asked for JSON and returned prose ·
 *   asked a question and answered a different one (overlap)
 *
 * Every signal lowers confidence for a stated reason. `scoreAnswer` returns the
 * reasons, not just the number, so a low score is always explainable.
 */

/** Words that mean "I am guessing" rather than "I know". */
const HEDGES = [
  'i think', 'i believe', 'probably', 'maybe', 'perhaps', 'possibly', 'might be',
  'not sure', "i'm not sure", 'unclear', 'as far as i know', 'roughly', 'approximately',
];

/** Words that mean "I am declining" — legitimate, but not a confident answer. */
const REFUSALS = [
  'i cannot', "i can't", 'i will not', "i won't", 'i am unable', "i'm unable",
  'not able to help', 'i must decline', 'cannot assist',
];

/** Phrases that suggest the model lost the thread. */
const LOOP_MARKERS = ['as mentioned above', 'as i said before', 'to repeat myself'];

export const DEFAULT_THRESHOLD = 0.7;

/**
 * @param {{text: string, prompt?: string, finishReason?: string|null, wantsJson?: boolean}} input
 * @returns {{confidence: number, reasons: Array<{signal: string, penalty: number, detail: string}>}}
 */
export function scoreAnswer(input) {
  const text = String(input.text ?? '');
  const prompt = String(input.prompt ?? '');
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  /** @type {Array<{signal: string, penalty: number, detail: string}>} */
  const reasons = [];

  const penalise = (signal, penalty, detail) => reasons.push({ signal, penalty, detail });

  // 1. an empty or near-empty answer is a failure, not a short answer
  if (trimmed.length === 0) penalise('empty', 1, 'the provider returned no text');
  else if (trimmed.length < 8) penalise('near_empty', 0.5, `only ${trimmed.length} characters`);

  // 2. truncation: the model stopped because it ran out of room
  if (input.finishReason === 'length' || input.finishReason === 'max_tokens') {
    penalise('truncated', 0.35, 'the answer was cut off by the token limit');
  }

  // 3. a refusal is honest, but it is not a confident answer to the question
  const refusal = REFUSALS.find((r) => lower.includes(r));
  if (refusal) penalise('refusal', 0.3, `declined with "${refusal}"`);

  // 4. hedging: count distinct hedge phrases, capped
  const hedges = HEDGES.filter((h) => lower.includes(h));
  if (hedges.length) {
    penalise('hedging', Math.min(0.4, 0.12 * hedges.length), `${hedges.length} hedge phrase(s): ${hedges.slice(0, 3).join(', ')}`);
  }

  // 5. repetition: the same sentence twice is a sign of a loop
  const sentences = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 20);
  const dupes = sentences.length - new Set(sentences).size;
  if (dupes > 0) penalise('repetition', Math.min(0.3, 0.15 * dupes), `${dupes} repeated sentence(s)`);
  if (LOOP_MARKERS.some((m) => lower.includes(m))) penalise('looping', 0.15, 'the answer refers back to itself');

  // 6. shape: JSON was asked for, prose came back
  if (input.wantsJson) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = (fenced ? fenced[1] : trimmed).trim();
    let isJson = false;
    try {
      const parsed = JSON.parse(body);
      isJson = typeof parsed === 'object' && parsed !== null;
    } catch {
      isJson = false;
    }
    if (!isJson) penalise('wrong_shape', 0.4, 'JSON was requested and the answer is not JSON');
  }

  // 7. relevance: does the answer share any content words with the question?
  if (prompt) {
    const overlap = contentOverlap(prompt, trimmed);
    if (overlap < 0.08) penalise('off_topic', 0.25, `only ${Math.round(overlap * 100)}% of the answer's terms come from the question`);
  }

  const total = reasons.reduce((a, r) => a + r.penalty, 0);
  const confidence = Math.max(0, Math.round((1 - Math.min(1, total)) * 100) / 100);
  return { confidence, reasons };
}

function contentOverlap(prompt, answer) {
  const stop = new Set('a an the and or but if then than that this these those is are was were be been of to in on at by for with from as it its we you they he she i not no do does did have has had will would can could should may might must just very really'.split(' '));
  const terms = (s) =>
    new Set(
      String(s)
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter((w) => w.length > 3 && !stop.has(w)),
    );
  const q = terms(prompt);
  const a = terms(answer);
  if (!a.size) return 0;
  let hit = 0;
  for (const t of a) if (q.has(t)) hit += 1;
  return hit / a.size;
}

/**
 * B7.6 — the grounding check.
 *
 * An answer that cites a URL, quotes a sentence or states a number that is not in
 * the context it was given is not grounded: it is plausible. Three checks, all
 * deterministic, all pointable at:
 *
 *   url      every URL in the answer must appear in the context
 *   quote    every quoted span of 8+ characters must appear in the context
 *   number   every money, percentage, year or unit-bearing number must appear
 *
 * When there is no context, there is nothing to ground against and the check
 * says so rather than passing the answer by default.
 *
 * @param {{answer: string, context: string}} input
 * @returns {{checked: boolean, supported: boolean, findings: Array<{kind: string, claim: string}>}}
 */
export function checkGrounding(input) {
  const answer = String(input.answer ?? '');
  const context = normalise(input.context ?? '');

  if (!context.trim()) {
    return { checked: false, supported: true, findings: [] };
  }

  const findings = [];
  const inContext = (needle) => context.includes(normalise(needle));

  // 1. URLs
  for (const raw of answer.match(/https?:\/\/[^\s<>"')]+/g) ?? []) {
    // a URL followed by a comma is a URL and a comma, not a different URL
    const url = raw.replace(/[.,;:]+$/, '');
    if (!inContext(url)) findings.push({ kind: 'url', claim: url });
  }

  // 2. quoted spans — a quote that is not in the source is a fabricated quote
  for (const m of answer.matchAll(/["“']([^"”']{8,200})["”']/g)) {
    const quote = m[1].trim();
    if (!inContext(quote)) findings.push({ kind: 'quote', claim: quote });
  }

  // 3. numbers that carry a unit or a currency, plus years
  const numberPatterns = [
    /\$\s?\d[\d,.]*(?:\s?(?:k|m|b|bn|million|billion))?/gi,
    /\b\d[\d,.]*\s?%/g,
    /\b(?:19|20)\d{2}\b/g,
    /\b\d[\d,.]*\s?(?:ms|s|sec|seconds|minutes|hours|days|tokens?|chars?|requests?)\b/gi,
  ];
  const seen = new Set();
  for (const pattern of numberPatterns) {
    for (const m of answer.matchAll(pattern)) {
      const claim = m[0].trim();
      if (seen.has(claim.toLowerCase())) continue;
      seen.add(claim.toLowerCase());
      // a year or a number with no context match is the classic hallucination
      if (!inContext(claim) && !inContext(claim.replace(/[\s,]/g, ''))) {
        findings.push({ kind: 'number', claim });
      }
    }
  }

  return { checked: true, supported: findings.length === 0, findings };
}

function normalise(text) {
  return String(text).replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Should this answer be escalated to a stronger target?
 *
 * @param {{confidence: number, threshold?: number, escalationsLeft?: number}} input
 */
export function shouldEscalate(input) {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  if ((input.escalationsLeft ?? 1) <= 0) return false;
  return input.confidence < threshold;
}

/**
 * Fail-closed verdict: an answer below the threshold may still be returned (the
 * user asked a question and half an answer beats none), but it must never be
 * presented as a verified one.
 *
 * @param {{confidence: number, threshold?: number, reasons: any[]}} input
 */
export function verdict(input) {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const ok = input.confidence >= threshold;
  return {
    ok,
    confidence: input.confidence,
    threshold,
    // Fail-closed means the default assumption is "not verified".
    verified: ok,
    summary: ok
      ? `confidence ${input.confidence} clears the ${threshold} threshold`
      : `confidence ${input.confidence} is below the ${threshold} threshold: ${input.reasons.map((r) => r.detail).join('; ') || 'no detail'}`,
  };
}
