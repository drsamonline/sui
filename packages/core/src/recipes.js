/**
 * B5.3 — recipes: a named patch you apply to a config.
 *
 * The point is that a working setup should not require reading a schema. A recipe
 * says "here is a free-tier stack" or "here is a privacy-strict gateway", and
 * applying it merges the pieces you are missing.
 *
 * Three rules, because a config file is someone's work:
 *
 *   1. **Never overwrite silently.** An existing provider, model or combo is kept
 *      unless `force` is set, and the conflict is reported either way.
 *   2. **Applying twice is a no-op.** Every change is checked for before it is made.
 *   3. **A dry run touches nothing.** The same code path returns the changes and
 *      writes no file.
 */

/**
 * @param {any} config
 * @param {any} recipe
 * @param {{force?: boolean}} [opts]
 */
export function applyRecipe(config, recipe, opts = {}) {
  const force = Boolean(opts.force);
  const next = structuredClone(config);
  /** @type {Array<{path: string, action: string, note?: string}>} */
  const changes = [];
  /** @type {Array<{path: string, reason: string}>} */
  const conflicts = [];
  /** @type {string[]} */
  const missingEnv = [];

  for (const [key, value] of Object.entries(recipe.requires?.env ?? {})) {
    if (!config.env?.[key] && !process.env[key]) missingEnv.push(key);
  }

  const mergeMap = (section) => {
    const patch = recipe.patch?.[section];
    if (!patch) return;
    next[section] ??= {};
    for (const [id, entry] of Object.entries(patch)) {
      const exists = next[section][id] !== undefined;
      if (exists && !force) {
        conflicts.push({ path: `${section}.${id}`, reason: 'already exists — kept as it is' });
        continue;
      }
      next[section][id] = entry;
      changes.push({ path: `${section}.${id}`, action: exists ? 'replaced' : 'added' });
    }
  };

  mergeMap('providers');
  mergeMap('models');
  mergeMap('combos');

  // Scalars are only set when absent: a recipe should not silently change a
  // decision someone already made.
  for (const [key, value] of Object.entries(recipe.patch?.settings ?? {})) {
    const [head, tail] = key.split('.');
    if (tail) {
      next[head] ??= {};
      if (next[head][tail] === undefined || force) {
        next[head][tail] = value;
        changes.push({ path: key, action: 'set' });
      } else if (next[head][tail] !== value) {
        conflicts.push({ path: key, reason: `already ${JSON.stringify(next[head][tail])} — kept` });
      }
    }
  }

  // Arrays are appended without duplicates.
  for (const [key, values] of Object.entries(recipe.patch?.append ?? {})) {
    next[key] ??= [];
    for (const value of values) {
      const marker = typeof value === 'string' ? value : JSON.stringify(value);
      const present = next[key].some((v) => (typeof v === 'string' ? v : JSON.stringify(v)) === marker);
      if (present) {
        conflicts.push({ path: `${key}[]`, reason: `${marker} is already there` });
        continue;
      }
      next[key].push(value);
      changes.push({ path: `${key}[]`, action: 'appended', note: marker });
    }
  }

  return { config: next, changes, conflicts, missingEnv };
}

/** A one-line summary for a list. */
export function describeRecipe(recipe) {
  const counts = {
    providers: Object.keys(recipe.patch?.providers ?? {}).length,
    models: Object.keys(recipe.patch?.models ?? {}).length,
    combos: Object.keys(recipe.patch?.combos ?? {}).length,
  };
  return `${recipe.title} — adds ${counts.providers} provider(s), ${counts.models} model(s), ${counts.combos} combo(s)`;
}
