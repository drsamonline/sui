/**
 * B4.7 — the embedding tier, without a model.
 *
 * This is **feature hashing**, not a learned embedding: each token and each
 * adjacent token pair is hashed into a fixed number of dimensions with a signed
 * contribution, then the vector is normalised. Two prompts that share most of
 * their wording land close together; two paraphrases that share no words do not.
 *
 * That limitation is the point of saying it out loud. A real embedding model
 * needs a provider and quota; this needs neither, costs microseconds, and beats
 * exact-hash matching for the case that actually happens — the same question
 * asked again with a word changed.
 */

const DIMS = 256;

/** FNV-1a, 32-bit: fast, deterministic, good enough for bucketing. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 0);
}

/**
 * @param {string} text
 * @param {number} [dims]
 * @returns {Float64Array}
 */
export function embed(text, dims = DIMS) {
  const vector = new Float64Array(dims);
  const words = tokens(text);

  const add = (term, weight) => {
    const h = hash32(term);
    const index = h % dims;
    const sign = (h >>> 31) === 0 ? 1 : -1; // signed hashing keeps collisions from only adding
    vector[index] += sign * weight;
  };

  for (const word of words) add(word, 1);
  for (let i = 0; i + 1 < words.length; i++) add(`${words[i]} ${words[i + 1]}`, 0.5);

  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) vector[i] /= norm;
  return vector;
}

/** @param {Float64Array} a @param {Float64Array} b */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are already unit length
}
