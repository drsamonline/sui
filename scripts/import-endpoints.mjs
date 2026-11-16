#!/usr/bin/env node
/**
 * Import endpoint facts gathered by reading the reference projects in
 * packages/catalog/sources.json.
 *
 * This is a **curated table, not a scraper**, and that is deliberate: six
 * heterogeneous repositories do not parse into one shape, and a scraper that
 * guesses would import model-page URLs as API endpoints. Each row below records
 * which source it came from, so the provenance is per fact rather than per file.
 *
 * Every imported entry keeps the same posture as the 9router import:
 *   needs_probe: true, tos: review, verified_at: null.
 *
 * Run: node scripts/import-endpoints.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SEED = join(ROOT, 'packages', 'catalog', 'seed.json');

/**
 * Facts read from the sources. `auth` is 'none' only where a source documents
 * keyless use; anything a source shows with a key is 'key'.
 */
const FACTS = [
  // ---- the three that were still missing an endpoint (the actual gap) ----
  {
    provider: 'pollinations',
    label: 'Pollinations',
    base_url: 'https://gen.pollinations.ai/v1',
    auth: 'none',
    source: 'free-coding-models@b9269a5, openproxy@0cc2282',
    note: 'Keyless tier named in the spec. Endpoint recorded by two independent sources.',
  },
  {
    provider: 'llm7',
    label: 'LLM7',
    base_url: 'https://api.llm7.io/v1',
    auth: 'none',
    source: 'free-coding-models@b9269a5, openproxy@0cc2282',
    note: 'Keyless tier named in the spec.',
  },
  {
    provider: 'ovhcloud-ai',
    label: 'OVHcloud AI Endpoints',
    base_url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    auth: 'none',
    source: 'free-coding-models@b9269a5, openproxy@0cc2282, free-ai-models@9a0a8fb',
    note: 'Public AI Endpoints cluster. Recorded by three independent sources.',
  },

  // ---- keyless gateways worth a probe ----
  {
    provider: 'opencode-zen',
    label: 'OpenCode Zen',
    base_url: 'https://opencode.ai/zen/v1',
    auth: 'none',
    source: 'free-coding-models@b9269a5, openproxy@0cc2282',
    note: 'Gateway rather than a provider; may require its own credential.',
  },

  // ---- free-tier keyed providers these projects treat as usable ----
  { provider: 'deepinfra', label: 'DeepInfra', base_url: 'https://api.deepinfra.com/v1', auth: 'key', key_env: 'DEEPINFRA_API_KEY', source: 'free-coding-models@b9269a5, openproxy@0cc2282, free-ai-router@4e8652c' },
  { provider: 'sambanova', label: 'SambaNova', base_url: 'https://api.sambanova.ai/v1', auth: 'key', key_env: 'SAMBANOVA_API_KEY', source: 'free-ai-router@4e8652c, free-model-router@2949c38, free-coding-models@b9269a5' },
  { provider: 'siliconflow', label: 'SiliconFlow', base_url: 'https://api.siliconflow.com/v1', auth: 'key', key_env: 'SILICONFLOW_API_KEY', source: 'free-ai-router@4e8652c, openproxy@0cc2282' },
  { provider: 'scaleway', label: 'Scaleway Generative APIs', base_url: 'https://api.scaleway.ai/v1', auth: 'key', key_env: 'SCALEWAY_API_KEY', source: 'free-ai-router@4e8652c, free-coding-models@b9269a5' },
  { provider: 'chutes', label: 'Chutes', base_url: 'https://api.chutes.ai/v1', auth: 'key', key_env: 'CHUTES_API_KEY', source: '9router-auto-free@ae6c91d' },
  { provider: 'featherless', label: 'Featherless', base_url: 'https://api.featherless.ai/v1', auth: 'key', key_env: 'FEATHERLESS_API_KEY', source: 'openproxy@0cc2282' },
  { provider: 'kluster', label: 'Kluster.ai', base_url: 'https://api.kluster.ai/v1', auth: 'key', key_env: 'KLUSTER_API_KEY', source: 'openproxy@0cc2282' },
  { provider: 'fireworks', label: 'Fireworks', base_url: 'https://api.fireworks.ai/inference/v1', auth: 'key', key_env: 'FIREWORKS_API_KEY', source: 'free-ai-router@4e8652c, openproxy@0cc2282' },
];

const seed = JSON.parse(readFileSync(SEED, 'utf8'));
const byProvider = new Map(seed.entries.map((e) => [e.provider, e]));

let added = 0;
let filled = 0;
const conflicts = [];

for (const fact of FACTS) {
  const existing = byProvider.get(fact.provider);

  if (existing) {
    if (!existing.base_url) {
      existing.base_url = fact.base_url;
      existing.needs_probe = true;
      existing.notes = `${existing.notes ?? ''} Endpoint recorded by ${fact.source}.`.trim();
      filled += 1;
      continue;
    }
    if (existing.base_url !== fact.base_url) {
      // two sources disagreeing is information, not something to overwrite
      conflicts.push(`${fact.provider}: seed says ${existing.base_url}, source says ${fact.base_url}`);
    }
    continue;
  }

  const entry = {
    provider: fact.provider,
    label: fact.label,
    auth: fact.auth,
    ...(fact.key_env ? { key_env: fact.key_env } : {}),
    base_url: fact.base_url,
    model_family: 'openai-compatible',
    tos: 'review',
    privacy_retention: 'unknown',
    capabilities: ['chat', 'streaming'],
    needs_probe: true,
    notes: `Endpoint recorded by ${fact.source}. Unverified by this gateway.${fact.note ? ` ${fact.note}` : ''}`,
  };
  seed.entries.push(entry);
  byProvider.set(fact.provider, entry);
  added += 1;
}

seed.entries.sort((a, b) => a.provider.localeCompare(b.provider));
writeFileSync(SEED, `${JSON.stringify(seed, null, 2)}\n`);

const withUrl = seed.entries.filter((e) => e.base_url).length;
console.log('');
console.log(`  ${FACTS.length} fact(s) read from packages/catalog/sources.json`);
console.log(`  ${added} entr(y/ies) added, ${filled} existing entr(y/ies) given a base_url`);
console.log(`  catalogue: ${seed.entries.length} entries, ${withUrl} with an endpoint`);
if (conflicts.length) {
  console.log('');
  console.log('  Sources disagree with the seed (left as the seed has it):');
  for (const conflict of conflicts) console.log(`   - ${conflict}`);
}
console.log('');
