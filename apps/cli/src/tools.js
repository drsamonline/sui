/**
 * Coding-tool detection and one-click configuration.
 *
 * Where a tool has a config file we can merge into safely, we write it. Where it
 * stores settings inside an app (Cursor, Cline, Roo) we do not pretend otherwise:
 * we print the two fields to paste, because silently editing an app's internal
 * state is how you break someone's editor.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {{
 *   id: string, name: string, detected: boolean, evidence: string|null,
 *   setup: 'file'|'paste', configPath: string|null,
 *   fields?: string[], note?: string
 * }} Tool
 */

/** @param {{home?: string, env?: NodeJS.ProcessEnv}} [opts] @returns {Tool[]} */
export function detectTools(opts = {}) {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  // Coerced: fs.existsSync deprecates a non-string argument (DEP0187), and this
  // helper is handed whatever a caller builds. A path that is not a string does not
  // exist, and saying so is cheaper than a deprecation warning on every first run.
  const has = (p) => typeof p === 'string' && p.length > 0 && existsSync(p);
  const firstExisting = (...paths) => paths.find(has) ?? null;

  /** @type {Tool[]} */
  const tools = [];

  // Continue (VS Code / JetBrains)
  const continuePath = firstExisting(join(home, '.continue', 'config.json'), join(home, '.continue', 'config.yaml'));
  tools.push({
    id: 'continue',
    name: 'Continue',
    detected: Boolean(continuePath),
    evidence: continuePath,
    setup: continuePath?.endsWith('.json') ? 'file' : 'paste',
    configPath: continuePath,
    fields: ['models[].provider = openai', 'models[].apiBase = <endpoint>', 'models[].model = <combo>'],
  });

  // Aider
  const aiderBin = which('aider', env) ?? firstExisting(join(home, '.aider.conf.yml'), join(home, '.aider.conf.yaml'));
  tools.push({
    id: 'aider',
    name: 'Aider',
    detected: Boolean(aiderBin),
    evidence: aiderBin,
    setup: 'file',
    configPath: join(home, '.aider.conf.yml'),
    fields: ['openai-api-base', 'openai-api-key', 'model'],
  });

  // Zed
  const zedPath = firstExisting(join(home, '.config', 'zed', 'settings.json'), join(home, '.zed', 'settings.json'));
  tools.push({
    id: 'zed',
    name: 'Zed',
    detected: Boolean(zedPath) || has(join(home, '.local', 'share', 'zed')),
    evidence: zedPath,
    setup: zedPath ? 'file' : 'paste',
    configPath: zedPath,
    fields: ['language_models.openai.api_url', 'language_models.openai.available_models'],
  });

  // Cursor
  const cursorPath = firstExisting(join(home, '.cursor'), '/Applications/Cursor.app', join(home, '.config', 'Cursor'));
  tools.push({
    id: 'cursor',
    name: 'Cursor',
    detected: Boolean(cursorPath),
    evidence: cursorPath,
    setup: 'paste',
    configPath: null,
    fields: ['Settings → Models → OpenAI API Key', 'Settings → Models → Override OpenAI Base URL'],
    note: 'Cursor keeps this in its own database, so it has to be pasted in the UI.',
  });

  // Cline / Roo Code (VS Code extensions)
  const extRoots = [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-server', 'extensions'),
    join(home, '.cursor', 'extensions'),
  ];
  const extHit = extRoots.find((dir) => {
    if (!has(dir)) return false;
    try {
      return readDirSafe(dir).some((n) => /claude-dev|cline|roo-cline|roocode/i.test(n));
    } catch {
      return false;
    }
  });
  tools.push({
    id: 'cline',
    name: 'Cline / Roo Code',
    detected: Boolean(extHit),
    evidence: extHit ?? null,
    setup: 'paste',
    configPath: null,
    fields: ['API Provider = OpenAI Compatible', 'Base URL = <endpoint>', 'Model ID = <combo>'],
    note: 'The extension stores settings in VS Code global state; paste these three fields.',
  });

  // Codex CLI
  const codexPath = firstExisting(join(home, '.codex', 'config.toml'), which('codex', env));
  tools.push({
    id: 'codex',
    name: 'Codex CLI',
    detected: Boolean(codexPath),
    evidence: codexPath,
    setup: 'paste',
    configPath: join(home, '.codex', 'config.toml'),
    fields: ['model_provider', 'base_url = "<endpoint>"'],
  });

  // Anything that honours OPENAI_BASE_URL
  tools.push({
    id: 'env',
    name: 'Any OpenAI-compatible tool (env vars)',
    detected: true,
    evidence: 'always available',
    setup: 'paste',
    configPath: null,
    fields: ['OPENAI_BASE_URL=<endpoint>', 'OPENAI_API_KEY=<gateway key or any non-empty string>'],
  });

  return tools;
}

/**
 * Write a tool's config, merging rather than replacing.
 * @param {string} toolId
 * @param {{baseUrl: string, combo: string, apiKey: string, home?: string, dryRun?: boolean}} opts
 * @returns {{ok: boolean, path: string|null, message: string, snippet?: string}}
 */
export function writeToolConfig(toolId, opts) {
  const home = opts.home ?? homedir();
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const envSnippet = `export OPENAI_BASE_URL=${baseUrl}/v1\nexport OPENAI_API_KEY=${opts.apiKey}`;

  if (toolId === 'aider') {
    const path = join(home, '.aider.conf.yml');
    const block = [
      `# added by sui-router`,
      `openai-api-base: ${baseUrl}/v1`,
      `openai-api-key: ${opts.apiKey}`,
      `model: openai/${opts.combo}`,
    ].join('\n');
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const next = existing.includes('openai-api-base:')
      ? existing.replace(/openai-api-base:.*/g, `openai-api-base: ${baseUrl}/v1`)
      : `${existing.trimEnd()}${existing.trim() ? '\n' : ''}${block}\n`;
    if (!opts.dryRun) writeFileSync(path, next);
    return { ok: true, path, message: `Wrote ${path}. Aider will use ${opts.combo} through sui.` };
  }

  if (toolId === 'continue') {
    const path = join(home, '.continue', 'config.json');
    if (!existsSync(path)) {
      return {
        ok: false,
        path,
        message: 'Continue is installed but has no config.json yet. Open Continue once, then run this again.',
        snippet: JSON.stringify({ models: [{ title: 'sui', provider: 'openai', model: opts.combo, apiBase: `${baseUrl}/v1`, apiKey: opts.apiKey }] }, null, 2),
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { ok: false, path, message: `${path} is not valid JSON, so I left it alone. Fix it, then re-run.` };
    }
    parsed.models = Array.isArray(parsed.models) ? parsed.models : [];
    const entry = {
      title: `sui — ${opts.combo}`,
      provider: 'openai',
      model: opts.combo,
      apiBase: `${baseUrl}/v1`,
      apiKey: opts.apiKey,
    };
    const idx = parsed.models.findIndex((m) => m && m.apiBase === `${baseUrl}/v1`);
    if (idx >= 0) parsed.models[idx] = entry;
    else parsed.models.push(entry);
    if (!opts.dryRun) writeFileSync(path, JSON.stringify(parsed, null, 2));
    return { ok: true, path, message: `Added "${opts.combo}" to ${path}.` };
  }

  if (toolId === 'zed') {
    const path = existsSync(join(home, '.config', 'zed', 'settings.json'))
      ? join(home, '.config', 'zed', 'settings.json')
      : join(home, '.zed', 'settings.json');
    let parsed = {};
    if (existsSync(path)) {
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return { ok: false, path, message: `${path} is not valid JSON, so I left it alone.` };
      }
    }
    parsed.language_models = parsed.language_models ?? {};
    parsed.language_models.openai = {
      ...(parsed.language_models.openai ?? {}),
      api_url: `${baseUrl}/v1`,
      available_models: [...new Set([...(parsed.language_models.openai?.available_models ?? []), opts.combo])],
    };
    if (!opts.dryRun) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify(parsed, null, 2));
    }
    return { ok: true, path, message: `Pointed Zed at sui in ${path}.` };
  }

  return {
    ok: false,
    path: null,
    message: 'Paste these two lines into the tool:',
    snippet: envSnippet,
  };
}

function which(bin, env = process.env) {
  const path = String(env.PATH ?? '');
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readDirSafe(dir) {
  return readdirSync(dir);
}
