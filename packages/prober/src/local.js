/**
 * @sui/prober/local — B2.6, finding a model server on this machine.
 *
 * People run Ollama, LM Studio, llama.cpp, vLLM or LocalAI and then hand-write a
 * provider block for it. This finds it instead: probe the ports those servers
 * use, ask each one what it serves, and report what is actually there.
 *
 * Safety is the design constraint, not a detail:
 *
 *   - **Loopback only.** `127.0.0.1`, `::1` and `localhost` and nothing else. A
 *     scan that could reach the network is a port scanner, and shipping one
 *     inside a gateway is how a helpful feature becomes a liability.
 *   - **No credentials, no writes.** Every request is an unauthenticated GET of a
 *     public listing endpoint. Discovery changes nothing on the server.
 *   - **Short timeouts.** A closed port must cost milliseconds, not the request
 *     budget. Default 300ms, and a scan of the whole port list stays under a
 *     second in parallel.
 */

import { get } from 'node:http';

/** Ports these servers use by default. */
export const DEFAULT_PORTS = [11434, 1234, 8080, 5000, 8000, 3000, 11435];

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** @param {string} host */
export function isLoopback(host) {
  return LOOPBACK.has(String(host).trim().toLowerCase());
}

/** The two shapes worth asking for: Ollama's native API, and the OpenAI-compatible one. */
const PROBES = [
  { path: '/api/tags', kind: 'ollama', shape: (json) => (json?.models ?? []).map((m) => m.name).filter(Boolean) },
  { path: '/v1/models', kind: 'openai-compatible', shape: (json) => (json?.data ?? []).map((m) => m.id).filter(Boolean) },
];

/**
 * One unauthenticated GET, with a hard socket timeout.
 *
 * `node:http` rather than `fetch`, deliberately: a loopback probe wants a socket
 * with a deadline, and a `fetch` AbortSignal turned out to abort instantly under
 * a proxy environment — a bug that made every probe report "nothing here".
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('not JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * @param {{host?: string, port: number, timeoutMs?: number}} opts
 */
async function probePort(opts) {
  const host = opts.host ?? '127.0.0.1';
  if (!isLoopback(host)) {
    throw new Error(`Refusing to probe "${host}": local discovery is loopback-only.`);
  }
  const timeoutMs = Number(opts.timeoutMs ?? 300);
  const started = Date.now();

  for (const probe of PROBES) {
    try {
      const json = await getJson(`http://${host}:${opts.port}${probe.path}`, timeoutMs);
      const models = probe.shape(json);
      if (!models.length && probe.kind === 'openai-compatible') continue;
      return {
        kind: probe.kind,
        host,
        port: opts.port,
        baseUrl: `http://${host}:${opts.port}${probe.kind === 'ollama' ? '' : '/v1'}`,
        models,
        latencyMs: Date.now() - started,
      };
    } catch {
      // a closed port, a timeout, or something that is not a model server
    }
  }
  return null;
}

/**
 * Scan the loopback ports in parallel and return whatever answered.
 *
 * @param {{hosts?: string[], ports?: number[], timeoutMs?: number}} [opts]
 */
export async function discoverLocalRuntimes(opts = {}) {
  const hosts = opts.hosts ?? ['127.0.0.1'];
  for (const host of hosts) {
    if (!isLoopback(host)) throw new Error(`Refusing to probe "${host}": local discovery is loopback-only.`);
  }
  const ports = opts.ports ?? DEFAULT_PORTS;

  const results = await Promise.all(
    hosts.flatMap((host) => ports.map((port) => probePort({ host, port, timeoutMs: opts.timeoutMs }))),
  );

  return results.filter(Boolean).sort((a, b) => a.port - b.port);
}

/**
 * Turn a discovery result into the config fragments Sui needs: one provider, one
 * model per served model, and a combo that routes to them.
 *
 * The ids are derived from the kind and the model name, so running discovery
 * twice produces the same ids and the merge stays a no-op.
 *
 * @param {{kind: string, baseUrl: string, models: string[]}} found
 */
export function toConfigPatch(found) {
  const providerId = found.kind === 'ollama' ? 'ollama' : 'local-openai';
  const provider = {
    type: 'openai',
    baseUrl: found.baseUrl,
    apiKeyEnv: null,
    tier: 'free',
    privacy: { retention: 'none', trainsOnData: false },
    label: found.kind === 'ollama' ? 'Ollama (local)' : 'Local OpenAI-compatible server',
  };

  /** @type {Record<string, any>} */
  const models = {};
  /** @type {string[]} */
  const targets = [];
  for (const model of found.models) {
    const id = `${providerId}-${String(model).replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase()}`;
    models[id] = { provider: providerId, model, costPer1kIn: 0, costPer1kOut: 0, quality: 3, tier: 'free' };
    targets.push(id);
  }

  return {
    providers: { [providerId]: provider },
    models,
    combos: targets.length ? { local: { label: 'Local', strategy: 'fallback', targets } } : {},
  };
}
