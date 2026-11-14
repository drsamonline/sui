/**
 * @sui/gateway — public API.
 *
 *   import { createGateway } from '@sui/gateway';
 *   const gw = await createGateway({ configPath: './sui.config.json' });
 *   gw.server.listen(gw.config.server.port);
 *
 * Everything the CLI does is a thin wrapper over this.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CircuitBreaker } from '@sui/router';
import { ResponseCache } from '@sui/telemetry';
import { loadConfig, normalizeConfig, suiHome } from '@sui/core';
import { Ledger } from '@sui/telemetry';
import { Router } from '@sui/router';
import { openVaultForStartup } from '@sui/vault';
import { createSuiServer } from './server.js';

export { CircuitBreaker } from '@sui/router';
export { ResponseCache } from '@sui/telemetry';
export { Ledger } from '@sui/telemetry';
export { Router } from '@sui/router';
export { createSuiServer } from './server.js';
export { loadConfig, normalizeConfig, resolveCombo, checkToggle, sanitizeConfig, providerHasCredentials, estimatedCost, suiHome, defaultConfigPath } from '@sui/core';
export { SuiError, ProviderError, ConfigError, ExhaustedError } from '@sui/core';
export { createAdapter, displayName } from '@sui/providers';
export { INVARIANTS, auditConfig, BUDGETS } from '@sui/core';

/** Minimal .env reader — no dependency, no surprises, never overrides a real env var. */
export function loadEnvFile(path = '.env', env = process.env) {
  if (!existsSync(path)) return env;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in env) || !env[key]) env[key] = value;
  }
  return env;
}

/**
 * Build a gateway: config, ledger, breaker, cache, router and an HTTP server,
 * all wired together but not yet listening.
 *
 * @param {{configPath?: string, env?: NodeJS.ProcessEnv, configObject?: any, ledgerFile?: string|null, logger?: any}} [opts]
 */
export async function createGateway(opts = {}) {
  const env = opts.env ?? loadEnvFile(process.env.SUI_ENV_FILE ?? '.env', { ...process.env });
  const config = opts.configObject
    ? normalizeConfig(opts.configObject, { env })
    : loadConfig(opts.configPath, env);

  const home = suiHome(env);

  // B6.7, the second half of the air-gap: sealed storage for paid credentials.
  // Opened only when the gate (I4) is on. A locked or missing vault is a warning,
  // never a reason to refuse free-tier traffic.
  if (config.paidTiers?.enabled) {
    const vaultPath = config.paidTiers.vaultPath ?? join(home, 'vault.json');
    const opened = await openVaultForStartup({ path: vaultPath, env });
    config.vault = { path: vaultPath, reason: opened.reason, providers: Object.keys(opened.keys).sort() };
    for (const [providerId, key] of Object.entries(opened.keys)) {
      const provider = config.providers[providerId];
      if (provider?.apiKeyEnv && !config.env[provider.apiKeyEnv]) config.env[provider.apiKeyEnv] = key;
    }
  } else {
    config.vault = { path: null, reason: 'paid tier is closed (I4) — the vault was not opened', providers: [] };
  }
  const ledger = new Ledger({
    file: opts.ledgerFile === null ? null : opts.ledgerFile ?? join(home, 'ledger.jsonl'),
    salt: env.SUI_LEDGER_SALT ?? 'sui-local-salt',
  });
  const breaker = new CircuitBreaker(config.breaker);
  const cache = new ResponseCache({ ...config.server.cache });
  const logger = opts.logger ?? defaultLogger();
  const router = new Router({ config, ledger, breaker, cache, logger });
  const server = createSuiServer({ router, config, ledger, breaker, cache, logger });

  return { config, ledger, breaker, cache, router, server, env, home: resolve(home) };
}

function defaultLogger() {
  const quiet = process.env.SUI_QUIET === '1';
  return {
    debug: (...a) => !quiet && process.env.SUI_DEBUG === '1' && console.log('[sui]', ...a),
    info: (...a) => !quiet && console.log('[sui]', ...a),
    warn: (...a) => !quiet && console.warn('[sui]', ...a),
  };
}
