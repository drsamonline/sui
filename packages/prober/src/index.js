/**
 * @drsamonline/prober — the canary prober (B2.3).
 *
 * This is the batch that makes "verified before use" mean something. A catalogue
 * entry is an identity; a probed entry is a route. Nothing here runs on the
 * request path (I1): probes happen on a schedule, results are read from memory.
 *
 * Three levels, because "the endpoint answered" and "the endpoint can do what we
 * need" are different facts:
 *
 *   liveness    does the API respond at all
 *   readiness   does a minimal chat completion come back with usable text
 *   suitability does it actually stream, honour a JSON request, accept tools —
 *               only for the capabilities the entry claims
 *
 * Fixtures are tiny, versioned, synthetic and side-effect free: no customer
 * content, no write tools, nothing that could mutate state upstream.
 */

import { poolKey } from '@drsamonline/catalog';
import { pickChatModel } from '@drsamonline/core';

/** Bump when a fixture changes, so probe history stays comparable. */
/**
 * Is this URL something a probe should touch?
 *
 * HTTPS only, and never a loopback, link-local, private or metadata address:
 * those are the user's own machine or their cloud account, not a provider. The
 * one exception is an explicit loopback probe, which `sui local` asks for by
 * passing `allowLocal`.
 *
 * @param {string} baseUrl
 * @param {{allowLocal?: boolean}} [opts]
 * @returns {{ok: boolean, reason?: string}}
 */
export function probeAddressAllowed(baseUrl, opts = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: `not a URL: ${baseUrl}` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';

  if (url.protocol !== 'https:' && !(opts.allowLocal && isLoopback)) {
    return { ok: false, reason: `refusing to probe ${url.protocol}// — a probe needs https, unless it is an explicit loopback check` };
  }
  if (isLoopback && !opts.allowLocal) {
    return { ok: false, reason: 'refusing to probe a loopback address — use `sui local` for a model on this machine' };
  }
  // link-local (cloud metadata), private ranges, and bare IPv6 ULA
  if (/^169\.254\./.test(host)) return { ok: false, reason: 'refusing to probe a link-local address (cloud metadata lives there)' };
  if (/^10\./.test(host)) return { ok: false, reason: 'refusing to probe a private address' };
  if (/^192\.168\./.test(host)) return { ok: false, reason: 'refusing to probe a private address' };
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return { ok: false, reason: 'refusing to probe a private address' };
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host)) return { ok: false, reason: 'refusing to probe a private address' };
  if (host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: 'refusing to probe an internal hostname' };

  return { ok: true };
}

export const PROBE_FIXTURE_VERSION = '1.0.0';

export const FIXTURES = {
  readiness: {
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    // A reasoning model thinks before it speaks. 8 tokens were spent entirely on
    // thinking, so the reply was empty and a working provider was marked unusable.
    max_tokens: 256,
  },
  jsonSchema: {
    messages: [{ role: 'user', content: 'Return JSON with exactly one key "ok", set to true.' }],
    max_tokens: 256,
    response_format: { type: 'json_object' },
  },
  tools: {
    messages: [{ role: 'user', content: 'Call the get_time tool for the city Pune.' }],
    max_tokens: 60,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Return the current time for a city. Read-only.',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
  },
};

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Probe one catalogue entry.
 *
 * @param {any} entry a normalised catalogue entry
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number, capabilities?: string[]}} [opts]
 */
export async function probeTarget(entry, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const checkedAt = now();

  const key = entry.pool_key ?? poolKey(entry);
  const base = entry.base_url ? String(entry.base_url).replace(/\/+$/, '') : null;

  /** @type {{liveness: any, readiness: any, suitability: Record<string, any>}} */
  const levels = { liveness: null, readiness: null, suitability: {} };

  // A catalogue entry is data, and data can name any address. The prober fetches
  // what it is told, so without this guard a seeded or imported base_url of
  // http://169.254.169.254/ (cloud metadata) or http://127.0.0.1:6379 would be
  // fetched on the user's machine and the result reported as a provider's health.
  // A loopback probe is allowed when something asked for it explicitly, or when
  // the catalogue itself says this entry is a model server on this machine
  // (`local: true` — ollama, LM Studio). A remote provider claiming 127.0.0.1 is
  // not local, and is still refused.
  const allowLocal = opts.allowLocal === true || entry.local === true;
  const reachable = base ? probeAddressAllowed(base, { allowLocal }) : null;
  if (base && !reachable.ok) {
    return {
      pool_key: key,
      provider: entry.provider,
      checkedAt,
      fixtureVersion: PROBE_FIXTURE_VERSION,
      ok: false,
      verified: false,
      latencyMs: 0,
      levels,
      reasons: [reachable.reason],
      fixtures: {},
    };
  }


  if (!base) {
    return {
      pool_key: key,
      provider: entry.provider,
      checkedAt,
      fixtureVersion: PROBE_FIXTURE_VERSION,
      ok: false,
      verified: false,
      latencyMs: 0,
      levels,
      reasons: ['no endpoint to probe (base_url is null — the identity is unresolved)'],
    };
  }

  const headers = { 'content-type': 'application/json' };
  if (entry.auth === 'key' && entry.key_env && process.env[entry.key_env]) {
    headers.authorization = `Bearer ${process.env[entry.key_env]}`;
  }

  const started = now();
  const reasons = [];

  // ---- liveness -----------------------------------------------------------
  // The model list is also how we learn what to *call*. Imported entries carry a
  // model family, not a model name, and probing with the family ("openai-compatible")
  // would fail against a perfectly healthy endpoint.
  /** @type {string[]} */
  let discoveredModels = [];
  levels.liveness = await timed(async () => {
    const res = await fetchImpl(`${base}/models`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      discoveredModels = rows
        .map((row) => (typeof row === 'string' ? row : row?.id ?? row?.name))
        .filter((id) => typeof id === 'string' && id.length > 0)
        // a chat probe wants a chat model, not an embedding or a speech model
        .filter((id) => !/embed|whisper|tts|moderation|rerank|guard|image|video|audio/i.test(id));
    }
    return {
      ok: res.ok,
      status: res.status,
      models: discoveredModels.length,
      note: res.ok ? `answered /models (${discoveredModels.length} model(s))` : `HTTP ${res.status}`,
    };
  });

  // ---- readiness ----------------------------------------------------------
  // If liveness did not even reach the host, readiness cannot tell us anything
  // new: it would only spend another timeout to say the same thing.
  const reachedHost = levels.liveness.status !== undefined || levels.liveness.ok === true;
  let sample = '';
  if (!reachedHost) {
    levels.readiness = { ok: false, note: 'not attempted: endpoint unreachable', ms: 0 };
    reasons.push(`liveness: ${levels.liveness.note}`);
    return {
      pool_key: key,
      provider: entry.provider,
      checkedAt,
      fixtureVersion: PROBE_FIXTURE_VERSION,
      ok: false,
      verified: false,
      latencyMs: now() - started,
      levels,
      reasons,
    };
  }
  // The model that answered readiness is the model every later check must use. The
  // suitability probes used to ask for `modelFor(entry)` — a family name like
  // "openai-compatible" — so Groq answered readiness and then 404'd all three,
  // and a working provider was recorded as unsuitable.
  const provenModel = probeModel(entry, discoveredModels);

  levels.readiness = await timed(async () => {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: provenModel, ...FIXTURES.readiness }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, note: `HTTP ${res.status}: ${firstLine(body)}` };
    }
    const json = await res.json().catch(() => null);
    const message = json?.choices?.[0]?.message ?? {};
    // a reasoning model leaves `content` empty and puts the answer in `reasoning`
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : message.reasoning;
    sample = content || (typeof reasoning === 'string' ? reasoning : '');
    const ok = typeof sample === 'string' && sample.trim().length > 0;
    return { ok, status: res.status, note: ok ? 'returned text' : 'empty completion' };
  });

  if (!levels.readiness.ok) reasons.push(`readiness: ${levels.readiness.note}`);

  // ---- suitability --------------------------------------------------------
  const capabilities = opts.capabilities ?? entry.capabilities ?? [];
  if (levels.readiness.ok) {
    if (capabilities.includes('streaming')) {
      levels.suitability.streaming = await probeStreaming({ fetchImpl, base, headers, entry, timeoutMs, model: provenModel });
      if (!levels.suitability.streaming.ok) reasons.push(`streaming: ${levels.suitability.streaming.note}`);
    }
    if (capabilities.includes('json_schema')) {
      levels.suitability.json_schema = await probeJson({ fetchImpl, base, headers, entry, timeoutMs, model: provenModel });
      if (!levels.suitability.json_schema.ok) reasons.push(`json_schema: ${levels.suitability.json_schema.note}`);
    }
    if (capabilities.includes('tools')) {
      levels.suitability.tools = await probeTools({ fetchImpl, base, headers, entry, timeoutMs, model: provenModel });
      if (!levels.suitability.tools.ok) reasons.push(`tools: ${levels.suitability.tools.note}`);
    }
  }

  const ok =
    levels.liveness.ok &&
    levels.readiness.ok &&
    Object.values(levels.suitability).every((s) => s.ok);

  return {
    pool_key: key,
    provider: entry.provider,
    checkedAt,
    fixtureVersion: PROBE_FIXTURE_VERSION,
    ok,
    // "verified" is stricter than "ok": a probe that only proves liveness does
    // not prove the route can carry a conversation.
    verified: ok && levels.readiness.ok,
    latencyMs: now() - started,
    sample: sample.slice(0, 40),
    levels,
    reasons,
  };
}

/** Streaming must be a real event sequence, not one blob pretending to be SSE. */
async function probeStreaming({ fetchImpl, base, headers, entry, timeoutMs, model }) {
  return timed(async () => {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, stream: true, ...FIXTURES.readiness }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, note: `HTTP ${res.status}` };
    if (!res.body) return { ok: false, status: res.status, note: 'no response body to stream' };

    let frames = 0;
    let deltas = 0;
    let done = false;
    let buffer = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (frames < 200) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          frames += 1;
          if (data === '[DONE]') {
            done = true;
            continue;
          }
          try {
            const payload = JSON.parse(data);
            if (payload.choices?.[0]?.delta?.content) deltas += 1;
          } catch {
            /* a keepalive frame is not a failure */
          }
        }
      }
      if (done) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }

    const ok = frames > 0 && deltas > 0;
    return {
      ok,
      status: res.status,
      note: ok ? `${frames} frames, ${deltas} content deltas` : `${frames} frames, ${deltas} content deltas — not a real stream`,
      frames,
      deltas,
    };
  });
}

/** A JSON request has to come back as JSON, not as a promise to be JSON. */
async function probeJson({ fetchImpl, base, headers, entry, timeoutMs, model }) {
  return timed(async () => {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, ...FIXTURES.jsonSchema }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, note: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    const content = json?.choices?.[0]?.message?.content ?? '';
    const fenced = String(content).match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = (fenced ? fenced[1] : content).trim();
    try {
      const parsed = JSON.parse(body);
      return { ok: typeof parsed === 'object' && parsed !== null, status: res.status, note: 'returned parseable JSON' };
    } catch {
      return { ok: false, status: res.status, note: 'returned text that is not JSON' };
    }
  });
}

/**
 * Tools: the check is that the request is *accepted* and the response has a valid
 * shape — not that the model chose to call the tool. Refusing to call a tool is a
 * legitimate answer; a 400 is not.
 */
async function probeTools({ fetchImpl, base, headers, entry, timeoutMs, model }) {
  return timed(async () => {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, ...FIXTURES.tools }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, note: `HTTP ${res.status} — tools rejected` };
    const json = await res.json().catch(() => null);
    const message = json?.choices?.[0]?.message;
    const ok = Boolean(message && (Array.isArray(message.tool_calls) || typeof message.content === 'string'));
    return { ok, status: res.status, note: ok ? 'tool schema accepted' : 'response had neither tool_calls nor content' };
  });
}

/**
 * Which model to call for the readiness check.
 *
 * In order: an explicit `probe_model` from the catalogue, then the first model
 * the endpoint itself listed, then a known default for a family we recognise.
 * A family name like "openai-compatible" is never sent as a model — that is a
 * category, and every real endpoint rejects it.
 */
function probeModel(entry, discovered = []) {
  if (entry.probe_model) return entry.probe_model;
  if (discovered.length) {
    // a provider's /models lists TTS, embedding and guard models too: taking the
    // first id put Groq's Arabic TTS voice in front of a chat probe
    return pickChatModel(discovered) ?? discovered[0];
  }
  const family = entry.model_family;
  if (family && !/compatible|mixed|unknown/i.test(family)) return family;
  return 'default';
}

async function timed(fn) {
  const t0 = performance.now();
  try {
    const result = await fn();
    return { ...result, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    const e = /** @type {any} */ (err);
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, note: timedOut ? 'timed out' : `unreachable: ${e?.message ?? e}`, ms: Math.round(performance.now() - t0) };
  }
}

function firstLine(s) {
  return String(s ?? '').split('\n')[0].slice(0, 120);
}

/**
 * B10.1 — the Weather Map's vocabulary.
 *
 * Three labels, because a person reading a status page needs a word, not a state
 * machine: thriving, resting, down. `unverified` is its own answer — "nobody has
 * checked yet" is not the same as "down", and saying so is the point.
 *
 * @param {string} status
 */
export function weatherLabel(status) {
  if (status === 'healthy') return 'thriving';
  if (status === 'degraded') return 'resting';
  if (status === 'disabled') return 'down';
  if (status === 'unverified') return 'unverified';
  return 'down';
}

/** A one-line, plain-language reading of a probe row. */
export function weatherSentence(row) {
  const name = row.provider;
  if (row.weather === 'unverified') return `${name}: not probed yet, so it is not in the pool.`;
  if (row.weather === 'thriving') {
    return `${name}: thriving — ${row.history?.length ?? 0} probe(s) on record, last one answered in ${row.latencyMs ?? '—'} ms.`;
  }
  const why = (row.reasons ?? [])[0] ?? 'no reason recorded';
  return `${name}: ${row.weather} — ${row.failures} consecutive failure(s). ${why}.`;
}

/**
 * The prober: state, thresholds and the schedule.
 *
 * `auto_disable_after_failures` and `auto_re_enable_on_recovery` are the two
 * behaviours that keep a free tier honest: a broken route leaves the pool after
 * three consecutive failures, and comes back the moment a probe succeeds.
 */
export class Prober {
  /**
   * @param {{
   *   entries: any[], intervalMs?: number, failuresBeforeDisable?: number,
   *   fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number,
   *   onResult?: (result: any, state: any) => void
   * }} opts
   */
  constructor(opts) {
    this.entries = opts.entries ?? [];
    this.intervalMs = opts.intervalMs ?? 3600_000;
    this.failuresBeforeDisable = opts.failuresBeforeDisable ?? 3;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs;
    this.now = opts.now ?? Date.now;
    this.onResult = opts.onResult ?? null;
    // explicit opt-in for a loopback probe (tests and `sui local`); the default
    // refuses the user's own machine and their cloud metadata
    this.allowLocal = opts.allowLocal === true;

    /** @type {Map<string, any>} */
    this.state = new Map();
    for (const entry of this.entries) {
      const key = entry.pool_key ?? poolKey(entry);
      this.state.set(key, {
        pool_key: key,
        provider: entry.provider,
        status: 'unverified',
        failures: 0,
        lastProbeAt: null,
        lastOkAt: null,
        lastResult: null,
        history: [],
      });
    }
    this.timer = null;
    this.runs = 0;
  }

  /** Probe everything once, in parallel, and fold the results into state. */
  async runOnce() {
    this.runs += 1;
    const results = await Promise.all(
      this.entries.map((entry) => probeTarget(entry, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, now: this.now, allowLocal: this.allowLocal })),
    );

    for (const result of results) {
      const key = result.pool_key;
      const current = this.state.get(key) ?? { pool_key: key, provider: result.provider, failures: 0, history: [] };
      current.lastProbeAt = result.checkedAt;
      current.lastResult = result;
      current.history = [...(current.history ?? []), { at: result.checkedAt, ok: result.ok, latencyMs: result.latencyMs }].slice(-24);

      if (result.ok) {
        current.failures = 0;
        current.status = 'healthy';
        current.lastOkAt = result.checkedAt;
      } else {
        current.failures += 1;
        current.status = current.failures >= this.failuresBeforeDisable ? 'disabled' : 'degraded';
      }
      this.state.set(key, current);
      this.onResult?.(result, current);
    }
    return results;
  }

  /** The probe map the catalogue's scoring function expects. */
  probeMap() {
    /** @type {Record<string, any>} */
    const map = {};
    for (const [key, s] of this.state.entries()) {
      map[key] = {
        ok: s.status === 'healthy',
        latencyMs: s.lastResult?.latencyMs ?? null,
        checkedAt: s.lastProbeAt,
      };
    }
    return map;
  }

  /** Snapshot for the dashboard and `sui probe --json`. */
  snapshot() {
    return [...this.state.values()].map((s) => ({
      pool_key: s.pool_key,
      provider: s.provider,
      status: s.status,
      weather: weatherLabel(s.status),
      failures: s.failures,
      lastProbeAt: s.lastProbeAt,
      lastOkAt: s.lastOkAt,
      latencyMs: s.lastResult?.latencyMs ?? null,
      reasons: s.lastResult?.reasons ?? [],
      suitability: s.lastResult?.levels?.suitability ?? {},
      // the last 24 observations, for the trend line (B10.1)
      history: s.history ?? [],
    }));
  }

  /** Start the schedule. Returns this, so it can be chained or stopped. */
  start() {
    if (this.timer) return this;
    this.runOnce().catch(() => {});
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
export { discoverLocalRuntimes, toConfigPatch, isLoopback, DEFAULT_PORTS } from './local.js';
