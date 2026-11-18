/**
 * @drsamonline/router/classify — the 50 ms classifier (B3.5).
 *
 * Before a request goes anywhere, decide whether it needs the expensive model.
 * The classifier is deterministic and has no model of its own: it reads the
 * prompt's shape, and it must answer in well under 50 ms, because a classifier
 * that costs a request has defeated the point of saving one.
 *
 * Signals, each of which can be pointed at in a test:
 *
 *   length      a long prompt is usually a real task, not a lookup
 *   code        fenced code, or a request to write/debug code
 *   multi-step  "first … then", numbered steps, "after that"
 *   reasoning   arithmetic, comparison, "why", "prove", "explain the trade-off"
 *   schema      JSON/schema/tool output wanted
 *   terse       a short factual question with no verbs that ask for work
 *
 * The output is a decision, not a score: `simple` or `complex`, plus the signals
 * that produced it so `sui explain` can say why.
 */

const COMPLEX_MARKERS = [
  'first', 'then', 'after that', 'step by step', 'steps', 'walk me through',
  'prove', 'derive', 'trade-off', 'tradeoff', 'compare', 'why does', 'why is',
  'architect', 'design', 'migrate', 'refactor', 'optimi', 'debug', 'root cause',
];

const CODE_MARKERS = [
  '```', 'function', 'class ', 'import ', 'select ', 'regex', 'sql', 'typescript',
  'javascript', 'python', 'rust', 'golang', 'compile', 'stack trace', 'unit test',
];

const SCHEMA_MARKERS = ['json', 'schema', 'tool_call', 'function call', 'yaml', 'csv', 'table'];

const TRIVIAL_MARKERS = ['what is', 'who is', 'when did', 'how many', 'capital of', 'define'];

/** Cheap token estimate: the classifier must not parse, just count. */
function words(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' || text[i] === '\n') count += 1;
  return count + 1;
}

/**
 * @param {string} text
 * @param {{maxMs?: number, longWords?: number}} [opts]
 * @returns {{complexity: 'simple'|'complex', signals: string[], ms: number, confidence: number}}
 */
export function classifyPrompt(text, opts = {}) {
  const started = process.hrtime.bigint();
  const prompt = String(text ?? '');
  const lower = prompt.toLowerCase();
  const signals = [];

  const wordCount = words(prompt);
  const longWords = opts.longWords ?? 120;

  if (wordCount > longWords) signals.push(`long prompt (${wordCount} words)`);
  if (CODE_MARKERS.some((m) => lower.includes(m))) signals.push('code');
  if (SCHEMA_MARKERS.some((m) => lower.includes(m))) signals.push('schema');
  const multiStep = COMPLEX_MARKERS.filter((m) => lower.includes(m));
  if (multiStep.length) signals.push(`multi-step (${multiStep.slice(0, 3).join(', ')})`);
  if (/\d+\s*[-+*/x×]\s*\d+/.test(prompt)) signals.push('arithmetic');
  if (/\?[^?]*\?/.test(prompt)) signals.push('multiple questions');

  // A short, single-question lookup with none of the work markers is simple.
  const looksTrivial =
    wordCount < 40 &&
    !signals.includes('code') &&
    !signals.includes('schema') &&
    multiStep.length === 0 &&
    TRIVIAL_MARKERS.some((m) => lower.startsWith(m) || lower.includes(m));

  const complexity = signals.length === 0 || (looksTrivial && signals.length <= 1) ? 'simple' : 'complex';

  // Confidence is about the distance from the decision, not about being right.
  const confidence =
    complexity === 'complex'
      ? Math.min(0.95, 0.5 + 0.15 * signals.length)
      : Math.max(0.55, 0.9 - 0.1 * signals.length);

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (opts.maxMs && ms > opts.maxMs) {
    signals.push(`classifier took ${ms.toFixed(1)}ms (budget ${opts.maxMs}ms)`);
  }

  return { complexity, signals, ms: Math.round(ms * 1000) / 1000, confidence: Math.round(confidence * 100) / 100 };
}
