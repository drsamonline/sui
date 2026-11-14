/**
 * @sui/compression — prompt compression (B4.1, B4.3).
 *
 * The point is not "smaller prompts". It is that a free tier has a quota, and a
 * quota is spent in tokens. When a provider is plentiful, compress lightly; when
 * it is nearly spent, compress hard, so the last of the quota buys more turns.
 *
 * Two rules hold across every engine:
 *
 *   1. **Protected spans are never touched.** Fenced code, inline code, URLs,
 *      email addresses, file paths and JSON-looking blocks are lifted out before
 *      any engine runs and put back byte-for-byte afterwards. A compressor that
 *      breaks a code block has cost more than it saved.
 *   2. **A floor, not a target.** Every preset has a ratio it aims for and a
 *      floor it will not cross. If the text is mostly protected spans, the
 *      honest answer is "nothing to compress", not a mangled prompt.
 *
 * Honest labels: `session_dedup`, `rtk`, `headroom` and `caveman` are
 * deterministic text transforms. `llmlingua_2` and `ccr` are *approximations* of
 * the methods with those names — the real ones need a trained model or an
 * external cache. What ships here is the shape, without pretending otherwise.
 */

import { createHmac, randomUUID } from 'node:crypto';

export const ENGINES = ['canonicalise', 'session_dedup', 'rtk', 'headroom', 'caveman', 'llmlingua_2', 'ccr'];

export const PRESETS = {
  lite: { target: 0.15, floor: 0.02, engines: ['canonicalise', 'session_dedup', 'rtk'] },
  standard: { target: 0.3, floor: 0.05, engines: ['canonicalise', 'session_dedup', 'rtk', 'llmlingua_2'] },
  aggressive: { target: 0.5, floor: 0.1, engines: ['canonicalise', 'session_dedup', 'rtk', 'llmlingua_2', 'caveman'] },
  ultra: {
    target: 0.75,
    floor: 0.2,
    engines: ['canonicalise', 'session_dedup', 'rtk', 'llmlingua_2', 'caveman', 'headroom', 'ccr'],
  },
};

export const OUTPUT_STYLES = ['off', 'auto', 'terse', 'explanatory', 'bullet', 'code_only'];

/**
 * The output axis: a short instruction, not a rewrite of the user's prompt.
 *
 * These are deliberately terse — a directive that costs 200 tokens to save 300
 * is not a saving. Each is under 90 characters.
 */
export const STYLE_DIRECTIVES = {
  terse: 'Answer in as few words as possible. No preamble.',
  explanatory: 'Give the answer, then one short paragraph explaining why.',
  bullet: 'Answer as a short bullet list. No preamble.',
  code_only: 'Return only code. No prose, no explanation, no fences.',
};

/**
 * B4.4 — the adaptive dial.
 *
 * Scarce quota wants fewer output tokens, so the style tightens as the quota
 * empties. `explanatory` is only chosen when there is room to pay for it.
 *
 * @param {{fraction?: number, taskHint?: string}} [input]
 * @returns {{style: keyof typeof STYLE_DIRECTIVES, reason: string}}
 */
export function chooseStyle(input = {}) {
  const fraction = input.fraction ?? 1;
  const hint = String(input.taskHint ?? '').toLowerCase();

  if (/\b(code|function|refactor|test|regex|sql)\b/.test(hint)) {
    return { style: 'code_only', reason: 'the task looks like code, so prose is noise' };
  }
  if (fraction > 0.6) return { style: 'explanatory', reason: `${Math.round(fraction * 100)}% of quota left — room to explain` };
  if (fraction > 0.3) return { style: 'terse', reason: `${Math.round(fraction * 100)}% of quota left — keep it short` };
  return { style: 'bullet', reason: `${Math.round(fraction * 100)}% of quota left — bullets cost less than paragraphs` };
}

/**
 * Put the directive in front of the system message, without losing what was
 * already there.
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} style
 */
export function applyStyle(messages, style) {
  const directive = STYLE_DIRECTIVES[style];
  if (!directive) return messages;

  const out = [...messages];
  const systemIndex = out.findIndex((m) => m.role === 'system');
  if (systemIndex === -1) {
    out.unshift({ role: 'system', content: directive });
  } else {
    out[systemIndex] = { ...out[systemIndex], content: `${directive}\n\n${out[systemIndex].content}` };
  }
  return out;
}

/** Never compress past this, whatever the preset asks for. */
const HARD_MAX_RATIO = 0.8;
/** If protected spans cover more than this share of the text, do nothing. */
const PROTECTED_SKIP_SHARE = 0.8;

const STOPWORDS = new Set(
  'a an the and or but if then than that this these those is are was were be been being of to in on at by for with from as it its it\'s we you they he she i not no do does did have has had will would can could should may might must just very really quite rather also however therefore thus so such about into over under again further once here there when where why how all any both each few more most other some only own same too s t don now'.split(
    ' ',
  ),
);

/* ------------------------------------------------------------------ protection */

/**
 * Lift out everything that must survive untouched.
 * @param {string} text
 * @returns {{masked: string, spans: string[], protectedChars: number}}
 */
export function protect(text) {
  const spans = [];
  const hold = (s) => {
    spans.push(s);
    return `\u0000${spans.length - 1}\u0000`;
  };

  let masked = String(text ?? '');

  // order matters: fenced code first, so its contents are not re-matched
  masked = masked.replace(/```[\s\S]*?```/g, hold);
  masked = masked.replace(/`[^`\n]{1,400}`/g, hold);
  masked = masked.replace(/https?:\/\/[^\s<>"')]+/g, hold);
  masked = masked.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, hold);
  masked = masked.replace(/(?:\/[\w.@-]+){2,}\/?/g, hold); // file paths
  masked = masked.replace(/\b[0-9a-f]{7,40}\b/g, hold); // commit-ish ids
  masked = replaceJsonBlocks(masked, hold);

  const protectedChars = spans.reduce((a, s) => a + s.length, 0);
  return { masked, spans, protectedChars };
}

/** @param {string} text @param {string[]} spans */
export function restore(text, spans) {
  return String(text).replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)] ?? '');
}

/** Balanced-brace JSON blocks, capped so a stray "{" cannot swallow a prompt. */
function replaceJsonBlocks(text, hold) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if ((ch === '{' || ch === '[') && looksLikeJson(text, i)) {
      const end = matchBracket(text, i);
      if (end > i && end - i < 4000) {
        out += hold(text.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function looksLikeJson(text, start) {
  const window = text.slice(start, start + 200);
  return /"[^"]{1,40}"\s*:/.test(window) || /^\s*[[{]\s*$/.test(window.slice(0, 3));
}

function matchBracket(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length && i < start + 4000; i++) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* -------------------------------------------------------------------- engines */

/**
 * B4.2 — canonicalise before compressing, the way `lexora` does.
 *
 * Lossless normalisation: unicode form, line endings, zero-width characters,
 * smart quotes and dashes, ragged indentation, trailing spaces, repeated blank
 * lines. None of it changes what the text says, and every byte removed is a byte
 * the later engines do not have to reason about.
 */
export function canonicalise(text) {
  const before = text.length;
  let out = String(text)
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '') // zero-width and bidi controls
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2007\u202f]/g, ' ') // non-breaking spaces
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  // dedent: drop the indentation every non-empty line shares
  const lines = out.split('\n').filter((l) => l.trim());
  const indent = lines.length ? Math.min(...lines.map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0)) : 0;
  if (indent > 0) out = out.split('\n').map((l) => l.slice(Math.min(indent, l.length))).join('\n');

  const dropped = Math.max(0, before - out.length);
  return {
    text: out,
    droppedChars: dropped,
    note: dropped ? `normalised ${dropped} chars (unicode, quotes, indentation, blank lines)` : 'already canonical',
  };
}

/**
 * Drop paragraphs that repeat something already said. A conversation resent in
 * full on every turn is mostly repetition.
 * @param {string} text
 * @param {{store?: RecallStore}} [ctx]
 */
export function sessionDedup(text, ctx = {}) {
  const blocks = text.split(/\n{2,}/);
  const seen = new Set();
  const kept = [];
  let droppedChars = 0;

  for (const block of blocks) {
    const normalised = block.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalised.length < 40) {
      kept.push(block);
      continue;
    }
    if (seen.has(normalised) && !block.includes('\u0000')) {
      // A duplicated block is only droppable if it holds no protected span:
      // repeating code is still code, and the guarantee is that code survives.
      droppedChars += block.length;
      continue;
    }
    seen.add(normalised);
    kept.push(block);
  }

  const out = kept.join('\n\n');
  return {
    text: droppedChars ? `${out}\n\n[${droppedChars} chars of repeated context removed]` : out,
    droppedChars,
    note: droppedChars ? `dropped ${droppedChars} chars of duplicate context` : 'no duplicates',
  };
}

/**
 * Collapse repeated tokens and punctuation runs. "very very very" costs tokens;
 * "very ×3" does not.
 */
export function rtk(text) {
  const before = text.length;
  let out = text
    .replace(/\b(\w{2,})(\s+\1\b){2,}/gi, (m, word) => {
      const occurrences = (m.match(new RegExp(`\\b${word}\\b`, 'gi')) ?? []).length;
      return `${word} ×${occurrences}`;
    })
    .replace(/([!?.,])\1{2,}/g, '$1')
    .replace(/[ \t]{3,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n');

  return {
    text: out,
    droppedChars: Math.max(0, before - out.length),
    note: before === out.length ? 'no runs to collapse' : `collapsed ${before - out.length} chars of repetition`,
  };
}

/**
 * Split text into atoms where every protected placeholder is one indivisible
 * atom. Truncation must never cut a placeholder in half, or the span it stands
 * for is lost when the text is restored.
 * @param {string} text
 */
export function atomise(text) {
  const atoms = [];
  const re = /\u0000\d+\u0000/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) atoms.push(...text.slice(last, m.index).split(''));
    atoms.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) atoms.push(...text.slice(last).split(''));
  return atoms;
}

/**
 * Keep the head and the tail, drop the middle. For a long file dump the middle
 * is usually the least useful part of the context.
 */
export function headroom(text, opts = {}) {
  const keepHead = opts.keepHead ?? 0.6;
  const keepTail = opts.keepTail ?? 0.25;
  const maxChars = opts.maxChars ?? Math.max(600, Math.round(text.length * 0.5));

  if (text.length <= maxChars) return { text, droppedChars: 0, note: 'within budget' };

  // Atoms, so a placeholder is kept or dropped whole — never split.
  const atoms = atomise(text).map((a) => ({ a, prot: /^\u0000\d+\u0000$/.test(a) }));
  const protectedChars = atoms.reduce((n, x) => n + (x.prot ? x.a.length : 0), 0);

  // The guarantee wins over the budget: every protected span is kept, even if
  // that leaves less room than the preset asked for.
  const headBudget = Math.max(0, Math.round(maxChars * keepHead));
  const tailBudget = Math.max(0, Math.round(maxChars * keepTail));

  const keep = new Array(atoms.length).fill(false);

  // Walk the whole array for both passes. A `break` when the prose budget runs
  // out would skip every protected span past that point — which is exactly how
  // a JSON block in the middle of a prompt gets silently dropped.
  let headUsed = 0;
  let headFull = false;
  for (let i = 0; i < atoms.length; i++) {
    if (atoms[i].prot) {
      keep[i] = true;
      continue;
    }
    if (headFull) continue;
    if (headUsed + atoms[i].a.length > headBudget) {
      headFull = true;
      continue;
    }
    keep[i] = true;
    headUsed += atoms[i].a.length;
  }

  let tailUsed = 0;
  let tailFull = false;
  for (let i = atoms.length - 1; i >= 0; i--) {
    if (atoms[i].prot) {
      keep[i] = true;
      continue;
    }
    if (tailFull) continue;
    if (tailUsed + atoms[i].a.length > tailBudget) {
      tailFull = true;
      continue;
    }
    keep[i] = true;
    tailUsed += atoms[i].a.length;
  }

  let out = '';
  let dropped = 0;
  let inGap = false;
  for (let i = 0; i < atoms.length; i++) {
    if (keep[i]) {
      if (inGap) {
        out += `\n\n[… ${dropped} chars omitted from the middle …]\n\n`;
        dropped = 0;
        inGap = false;
      }
      out += atoms[i].a;
    } else {
      dropped += atoms[i].a.length;
      inGap = true;
    }
  }
  if (inGap) out += `\n\n[… ${dropped} chars omitted from the middle …]\n\n`;

  if (out.length >= text.length) return { text, droppedChars: 0, note: 'nothing safe to drop' };
  return {
    text: out,
    droppedChars: text.length - out.length,
    note: `dropped ${text.length - out.length} chars from the middle, kept ${protectedChars} chars of protected spans`,
  };
}

/**
 * Strip function words from prose lines only. Code, URLs and JSON are protected
 * before this runs, so "caveman" cannot turn a query into a syntax error.
 */
export function caveman(text) {
  const before = text.length;
  const out = text
    .split('\n')
    .map((line) => {
      if (!/[a-z]/i.test(line)) return line;
      const words = line.split(/(\s+)/);
      const kept = [];
      let atSentenceStart = true;

      for (const w of words) {
        if (/^\s+$/.test(w)) {
          kept.push(w);
          continue;
        }
        const bare = w.toLowerCase().replace(/[^a-z']/g, '');
        const structural = /[{}[\]()=<>+*/|&%$#@_\\]/.test(w);
        const keep = structural || atSentenceStart || !STOPWORDS.has(bare);
        if (keep) kept.push(w);
        // a sentence boundary is what makes the next word structural
        if (/[.!?:;]$/.test(w) || /^[-*•]$/.test(w)) atSentenceStart = true;
        else if (keep) atSentenceStart = false;
      }
      return kept.join('').replace(/\s{2,}/g, ' ').trim();
    })
    .join('\n');

  return {
    text: out,
    droppedChars: Math.max(0, before - out.length),
    note: before === out.length ? 'nothing to strip' : `removed ${before - out.length} chars of function words`,
  };
}

/**
 * An approximation of LLMLingua's idea: keep the sentences that carry the rare
 * terms, drop the ones that only repeat common ones. No model, no download —
 * a sentence score from term frequency inside this prompt.
 */
export function llmLingua2(text, opts = {}) {
  const keep = opts.keep ?? 0.7;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length < 3) return { text, droppedChars: 0, note: 'too few sentences to prune' };

  const df = new Map();
  for (const s of sentences) {
    for (const term of new Set(terms(s))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const scored = sentences.map((s, i) => {
    const t = terms(s);
    const score = t.reduce((a, term) => a + 1 / (df.get(term) ?? 1), 0) / Math.sqrt(Math.max(1, t.length));
    // A sentence holding a protected span scores as if it were priceless.
    const protectedBoost = s.includes('\u0000') ? 1000 : 0;
    return { s, i, score: score + protectedBoost + (i === sentences.length - 1 ? 0.5 : 0) };
  });

  const keepCount = Math.max(1, Math.round(sentences.length * keep));
  const keptIndexes = new Set(
    [...scored].sort((a, b) => b.score - a.score).slice(0, keepCount).map((x) => x.i),
  );
  // The last sentence is usually the actual ask. It is kept unconditionally.
  keptIndexes.add(sentences.length - 1);

  const out = sentences
    .map((s, i) => (keptIndexes.has(i) ? s : null))
    .filter(Boolean)
    .join(' ');
  return {
    text: out,
    droppedChars: Math.max(0, text.length - out.length),
    note: `kept ${keepCount}/${sentences.length} sentences by term rarity`,
  };
}

function terms(s) {
  return String(s)
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/* ----------------------------------------------------------------------- ccr */

/**
 * A recall store: what compression throws away is kept here, under a signed
 * token, so the full text can be recovered deliberately.
 *
 * This is the honest half of "compress, cache, retrieve": the prompt carries a
 * marker, and `retrieve(token)` returns what was dropped. The signature means a
 * token cannot be guessed from another prompt.
 */
export class RecallStore {
  /**
   * @param {{secret?: string, maxEntries?: number, now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    this.secret = opts.secret ?? process.env.SUI_RECALL_SECRET ?? 'sui-recall-local';
    this.maxEntries = opts.maxEntries ?? 200;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, {text: string, at: number}>} */
    this.entries = new Map();
  }

  /** @param {string} text */
  put(text) {
    const id = randomUUID().slice(0, 8);
    const sig = createHmac('sha256', this.secret).update(id).digest('hex').slice(0, 8);
    const token = `${id}.${sig}`;
    this.entries.set(token, { text, at: this.now() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return token;
  }

  /** @param {string} token */
  get(token) {
    const [id, sig] = String(token).split('.');
    if (!id || !sig) return null;
    const expected = createHmac('sha256', this.secret).update(id).digest('hex').slice(0, 8);
    if (expected !== sig) return null;
    return this.entries.get(token)?.text ?? null;
  }

  /** @param {string} token */
  verify(token) {
    const [id, sig] = String(token).split('.');
    if (!id || !sig) return false;
    return createHmac('sha256', this.secret).update(id).digest('hex').slice(0, 8) === sig;
  }
}

/**
 * Replace the middle of the prompt with a signed recall marker.
 * @param {string} text
 * @param {{store: RecallStore, keepShare?: number}} opts
 */
export function ccr(text, opts) {
  const store = opts?.store;
  const keepShare = opts?.keepShare ?? 0.5;
  if (!store) return { text, droppedChars: 0, note: 'no recall store — ccr skipped' };
  if (text.length < 400) return { text, droppedChars: 0, note: 'too short to recall' };

  const head = Math.round(text.length * keepShare);
  const dropped = text.slice(head);
  const token = store.put(dropped);
  const out = `${text.slice(0, head)}\n\n[sui:recall ${token} — ${dropped.length} chars omitted, retrievable]`;

  return { text: out, droppedChars: text.length - out.length, note: `moved ${dropped.length} chars behind a signed marker`, token };
}

/* -------------------------------------------------------------------- presets */

/**
 * Run a preset over a prompt.
 *
 * @param {string} text
 * @param {{preset?: keyof typeof PRESETS, store?: RecallStore, engines?: string[]}} [opts]
 * @returns {{text: string, preset: string, originalChars: number, compressedChars: number, ratio: number, savedChars: number, skipped: string|null, steps: Array<{engine: string, note: string, droppedChars: number}>, tokens: string[]}}
 */
export function compress(text, opts = {}) {
  const presetName = opts.preset ?? 'standard';
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Unknown compression preset "${presetName}". Use: ${Object.keys(PRESETS).join(', ')}.`);

  const original = String(text ?? '');
  const originalChars = original.length;
  const empty = {
    text: original,
    preset: presetName,
    originalChars,
    compressedChars: originalChars,
    ratio: 0,
    savedChars: 0,
    skipped: null,
    steps: [],
    tokens: [],
  };

  if (originalChars < 200) return { ...empty, skipped: 'too short to be worth compressing' };

  const { masked, spans, protectedChars } = protect(original);
  if (protectedChars / originalChars > PROTECTED_SKIP_SHARE) {
    return { ...empty, skipped: `${Math.round((protectedChars / originalChars) * 100)}% of this prompt is code, URLs or JSON — left alone` };
  }

  const target = Math.max(preset.floor, Math.min(HARD_MAX_RATIO, preset.target));
  const engines = opts.engines ?? preset.engines;
  let current = masked;
  const steps = [];
  const tokens = [];

  for (const engine of engines) {
    if (current.length <= masked.length * (1 - target)) break;
    let result;
    switch (engine) {
      case 'canonicalise':
        result = canonicalise(current);
        break;
      case 'session_dedup':
        result = sessionDedup(current, opts);
        break;
      case 'rtk':
        result = rtk(current);
        break;
      case 'caveman':
        result = caveman(current);
        break;
      case 'llmlingua_2':
        result = llmLingua2(current, { keep: 0.7 });
        break;
      case 'headroom':
        result = headroom(current, { maxChars: Math.round(current.length * 0.6) });
        break;
      case 'ccr':
        result = ccr(current, { store: opts.store, keepShare: 0.5 });
        break;
      default:
        result = { text: current, droppedChars: 0, note: `unknown engine "${engine}" — skipped` };
    }
    if (result.token) tokens.push(result.token);
    if (result.text.length < current.length) {
      steps.push({ engine, note: result.note, droppedChars: current.length - result.text.length });
      current = result.text;
    } else {
      steps.push({ engine, note: result.note, droppedChars: 0 });
    }
  }

  const restored = restore(current, spans);
  const compressedChars = restored.length;
  const savedChars = Math.max(0, originalChars - compressedChars);

  return {
    text: restored,
    preset: presetName,
    originalChars,
    compressedChars,
    ratio: originalChars ? Math.round((savedChars / originalChars) * 1000) / 1000 : 0,
    savedChars,
    skipped: null,
    steps,
    tokens,
  };
}

/* ------------------------------------------------------------ budget manager */

/**
 * B4.3 — pick a preset from what is left of the quota.
 *
 * The rule is simple on purpose: plentiful → compress lightly (quality first),
 * scarce → compress hard (a smaller prompt that still gets an answer beats a
 * perfect prompt the provider refuses).
 *
 * @param {{remaining?: number, limit?: number, fraction?: number}} quota
 * @returns {{preset: keyof typeof PRESETS, reason: string, fraction: number}}
 */
export function choosePreset(quota = {}) {
  const fraction =
    quota.fraction != null
      ? Number(quota.fraction)
      : quota.remaining != null && quota.limit
        ? Number(quota.remaining) / Number(quota.limit)
        : 1;

  if (fraction > 0.6) return { preset: 'lite', fraction, reason: `${Math.round(fraction * 100)}% of quota left — compress lightly` };
  if (fraction > 0.3) return { preset: 'standard', fraction, reason: `${Math.round(fraction * 100)}% of quota left — standard compression` };
  if (fraction > 0.1) return { preset: 'aggressive', fraction, reason: `${Math.round(fraction * 100)}% of quota left — compress hard` };
  return { preset: 'ultra', fraction, reason: `${Math.round(fraction * 100)}% of quota left — squeeze the last turns out of it` };
}
