/**
 * Provider adapters.
 *
 * Three wire formats cover essentially everything people route to today:
 *   - openai     OpenAI, Groq, Together, Fireworks, OpenRouter, DeepSeek, vLLM, Ollama, LM Studio
 *   - anthropic  Claude
 *   - gemini     Google AI Studio / Vertex express
 * plus `mock`, which answers in-process so the router can be tested and demoed
 * with no keys and no network.
 *
 * Every adapter returns the same normalised shape, so routing never has to
 * care which format the other end speaks.
 */

import { ProviderError, pickChatModel } from '@drsamonline/core';

/**
 * @typedef {{
 *   text: string, usage: {prompt_tokens: number, completion_tokens: number},
 *   finishReason: string|null, raw: any
 * }} NormalisedResult
 */

const DEFAULT_TIMEOUT_MS = 60000;

/** Human names, so error messages read like sentences. */
const DISPLAY = {
  groq: 'Groq',
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  mock: 'the mock provider',
};

export function displayName(providerId) {
  return DISPLAY[providerId] ?? providerId;
}

/**
 * @param {string} providerId
 * @param {any} provider
 * @param {NodeJS.ProcessEnv} [env]
 */
/**
 * B9.5 — access tokens for OAuth-style providers.
 *
 * A provider that hands out a short-lived token is not a provider with a broken
 * key. On a 401 we refresh **once**, retry **once**, and cache the token until
 * its stated expiry. A refresh loop would turn one bad credential into an outage.
 *
 * @type {Map<string, {token: string, expiresAt: number}>}
 */
const tokenCache = new Map();

/** @param {string} providerId */
export function clearToken(providerId) {
  tokenCache.delete(providerId);
}

/**
 * @param {{providerId: string, provider: any, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, now?: () => number}} input
 */
export async function refreshAccessToken(input) {
  const oauth = input.provider?.oauth;
  if (!oauth?.tokenUrl) throw new ProviderError(`Provider "${input.providerId}" has no tokenUrl to refresh against.`, { code: 'no_oauth' });

  const clientId = input.env[oauth.clientIdEnv ?? ''];
  const clientSecret = input.env[oauth.clientSecretEnv ?? ''];
  const refreshToken = input.env[oauth.refreshTokenEnv ?? ''];
  if (!clientId || !clientSecret || !refreshToken) {
    throw new ProviderError(
      `${displayName(input.providerId)} needs a refresh token: set ${oauth.clientIdEnv}, ${oauth.clientSecretEnv} and ${oauth.refreshTokenEnv}.`,
      { code: 'no_refresh_credentials', provider: input.providerId, status: 401 },
    );
  }

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
  if (oauth.scope) body.set('scope', oauth.scope);

  const doFetch = input.fetchImpl ?? fetch;
  const res = await doFetch(oauth.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new ProviderError(`${displayName(input.providerId)} refused to refresh its token (${res.status}).`, {
      code: 'refresh_failed',
      status: 401,
      provider: input.providerId,
      detail: detail.slice(0, 200),
    });
  }

  const json = await res.json();
  const token = json.access_token;
  if (!token) throw new ProviderError(`${displayName(input.providerId)} returned no access_token.`, { code: 'refresh_failed', status: 401 });

  const now = input.now ?? Date.now;
  // refresh a minute early so a request cannot expire mid-flight
  const expiresAt = now() + Math.max(0, (Number(json.expires_in ?? 3600) - 60) * 1000);
  tokenCache.set(input.providerId, { token, expiresAt });
  return { token, expiresAt };
}

/** A cached, still-valid token for this provider, or null. */
export function cachedToken(providerId, now = Date.now) {
  const entry = tokenCache.get(providerId);
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    tokenCache.delete(providerId);
    return null;
  }
  return entry.token;
}

import { sanitiseKey } from '@drsamonline/core';

export { sanitiseKey };

export function createAdapter(providerId, provider, env = process.env) {
  const initialKey = cachedToken(providerId) ?? sanitiseKey(provider.apiKey ?? (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined));
  const base = { id: providerId, type: provider.type, name: displayName(providerId), hasKey: Boolean(initialKey) };

  // An MCP server is a provider like any other (B5.4). Imported lazily because
  // @drsamonline/mcp depends on the router, which depends on this package.
  if (provider.type === 'mcp') {
    return {
      ...base,
      type: 'mcp',
      chat: async (req, opts = {}) => {
        const { createMcpAdapter } = await import('@drsamonline/mcp');
        return createMcpAdapter(providerId, provider, env).chat(req, opts);
      },
    };
  }

  /** Build the concrete call for a given key. */
  const build = (key) => {
    if (provider.type === 'openai') return (req, opts) => openaiChat(providerId, provider, key, req, opts);
    if (provider.type === 'anthropic') return (req, opts) => anthropicChat(providerId, provider, key, req, opts);
    if (provider.type === 'gemini') return (req, opts) => geminiChat(providerId, provider, key, req, opts);
    if (provider.type === 'mock') return (req, opts) => mockChat(providerId, provider, req, opts);
    throw new ProviderError(`Provider "${providerId}" has an unknown type "${provider.type}".`, {
      code: 'bad_provider_type',
      provider: providerId,
    });
  };

  /**
   * B9.5: one refresh, one retry, and only for a provider that has an OAuth
   * config. A refresh loop would turn one expired token into an outage.
   */
  const chat = async (req, opts = {}) => {
    const key = cachedToken(providerId) ?? initialKey;
    try {
      return await build(key)(req, opts);
    } catch (err) {
      const status = /** @type {any} */ (err)?.status;

      // A retired model id is the most common failure in this whole system: Groq
      // shut down llama-3.3-70b-versatile in August 2026 and every catalogue that
      // still named it started answering "that model does not exist". Ask the
      // provider what it has now, retry once, and say what changed — a hardcoded
      // model list in a config file cannot keep up, and the provider can.
      if (status === 404 && req?.model && !opts._rediscovered) {
        const discovered = await discoverModel(providerId, provider, key, env);
        if (discovered && discovered !== req.model) {
          const retried = await build(key)({ ...req, model: discovered }, { ...opts, _rediscovered: true });
          if (retried && typeof retried === 'object') {
            retried.modelSwitchedFrom = req.model;
            retried.model = discovered;
          }
          return retried;
        }
      }

      const isAuth = status === 401;
      if (!isAuth || !provider.oauth) throw err;
      await refreshAccessToken({ providerId, provider, env });
      return await build(cachedToken(providerId))(req, opts);
    }
  };

  return { ...base, chat };
}

/* ------------------------------------------------------------------ openai */

async function openaiChat(providerId, provider, apiKey, req, opts = {}) {
  const url = `${trimSlash(provider.baseUrl)}/chat/completions`;
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (provider.headers) Object.assign(headers, provider.headers);

  const body = {
    model: req.model,
    messages: req.messages,
    stream: Boolean(req.stream),
  };
  // B4.6: OpenAI caches prefixes automatically above a threshold; the key only
  // helps route the request to the same cache.
  if (req.cacheHints?.openai?.promptCacheKey) body.prompt_cache_key = req.cacheHints.openai.promptCacheKey;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.max_tokens != null) body.max_tokens = req.max_tokens;
  if (req.top_p != null) body.top_p = req.top_p;
  if (req.stop != null) body.stop = req.stop;
  if (req.stream) body.stream_options = { include_usage: true };

  const res = await fetchJson(url, { method: 'POST', headers, body }, provider, providerId, req.model);

  if (req.stream) {
    return readOpenAIStream(res, opts, req);
  }

  const json = await res.json();
  const choice = json.choices?.[0];
  const message = choice?.message ?? {};

  // A reasoning model answers with its thinking in `reasoning` and leaves `content`
  // empty when it runs out of tokens — which is exactly what Groq's gpt-oss models
  // do at max_tokens: 16. Reading only `content` reported "empty turn" for a request
  // that had been answered, and the answer was sitting in the response.
  const rawText = message.content ?? '';
  const content = typeof rawText === 'string' ? rawText : flattenParts(rawText);
  const reasoning = message.reasoning_content ?? message.reasoning ?? '';
  const text = content || (typeof reasoning === 'string' ? reasoning : '');

  return {
    text,
    usage: {
      prompt_tokens: json.usage?.prompt_tokens ?? estimateMessages(req.messages),
      completion_tokens: json.usage?.completion_tokens ?? estimateText(text),
    },
    finishReason: choice?.finish_reason ?? null,
    raw: json,
  };
}

async function readOpenAIStream(res, opts, req) {
  let text = '';
  let usage = null;
  let finishReason = null;
  await readSSE(res, (payload) => {
    const choice = payload.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta.length) {
      text += delta;
      opts.onToken?.(delta);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (payload.usage) usage = payload.usage;
  });
  return {
    text,
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? estimateMessages(req.messages),
      completion_tokens: usage?.completion_tokens ?? estimateText(text),
    },
    finishReason,
    raw: null,
  };
}

/* --------------------------------------------------------------- anthropic */

async function anthropicChat(providerId, provider, apiKey, req, opts = {}) {
  const url = `${trimSlash(provider.baseUrl)}/messages`;
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : flattenParts(m.content)))
    .join('\n\n');
  const messages = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : flattenParts(m.content),
    }));

  const body = {
    model: req.model,
    max_tokens: req.max_tokens ?? 1024,
    messages,
    stream: Boolean(req.stream),
  };
  if (system) {
    // B4.6: Anthropic wants an explicit breakpoint, on a content block.
    body.system = req.cacheHints?.anthropic?.breakpoint
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.stop != null) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetchJson(url, { method: 'POST', headers, body }, provider, providerId, req.model);

  if (req.stream) {
    let text = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    let finishReason = null;
    await readSSE(res, (payload) => {
      if (payload.type === 'content_block_delta' && payload.delta?.text) {
        text += payload.delta.text;
        opts.onToken?.(payload.delta.text);
      }
      if (payload.type === 'message_start' && payload.message?.usage) {
        usage.prompt_tokens = payload.message.usage.input_tokens ?? 0;
      }
      if (payload.type === 'message_delta') {
        if (payload.usage?.output_tokens != null) usage.completion_tokens = payload.usage.output_tokens;
        if (payload.delta?.stop_reason) finishReason = payload.delta.stop_reason;
      }
    });
    if (!usage.completion_tokens) usage.completion_tokens = estimateText(text);
    if (!usage.prompt_tokens) usage.prompt_tokens = estimateMessages(req.messages);
    return { text, usage, finishReason, raw: null };
  }

  const json = await res.json();
  const text = Array.isArray(json.content)
    ? json.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
    : '';
  return {
    text,
    usage: {
      prompt_tokens: json.usage?.input_tokens ?? estimateMessages(req.messages),
      completion_tokens: json.usage?.output_tokens ?? estimateText(text),
    },
    finishReason: json.stop_reason ?? null,
    raw: json,
  };
}

/* ------------------------------------------------------------------ gemini */

async function geminiChat(providerId, provider, apiKey, req, opts = {}) {
  const root = trimSlash(provider.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta');
  const method = req.stream ? 'streamGenerateContent' : 'generateContent';
  const url = `${root}/models/${encodeURIComponent(req.model)}:${method}${req.stream ? '?alt=sse' : ''}`;

  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : flattenParts(m.content)))
    .join('\n\n');

  const contents = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : flattenParts(m.content) }],
    }));

  const body = {
    contents,
    generationConfig: {
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.max_tokens != null ? { maxOutputTokens: req.max_tokens } : {}),
      ...(req.top_p != null ? { topP: req.top_p } : {}),
      ...(req.stop ? { stopSequences: Array.isArray(req.stop) ? req.stop : [req.stop] } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;

  const res = await fetchJson(url, { method: 'POST', headers, body }, provider, providerId, req.model);

  if (req.stream) {
    let text = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    let finishReason = null;
    await readSSE(res, (payload) => {
      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (p.text) {
          text += p.text;
          opts.onToken?.(p.text);
        }
      }
      if (payload.candidates?.[0]?.finishReason) finishReason = payload.candidates[0].finishReason;
      if (payload.usageMetadata) {
        usage.prompt_tokens = payload.usageMetadata.promptTokenCount ?? usage.prompt_tokens;
        usage.completion_tokens = payload.usageMetadata.candidatesTokenCount ?? usage.completion_tokens;
      }
    });
    if (!usage.completion_tokens) usage.completion_tokens = estimateText(text);
    if (!usage.prompt_tokens) usage.prompt_tokens = estimateMessages(req.messages);
    return { text, usage, finishReason, raw: null };
  }

  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('');
  return {
    text,
    usage: {
      prompt_tokens: json.usageMetadata?.promptTokenCount ?? estimateMessages(req.messages),
      completion_tokens: json.usageMetadata?.candidatesTokenCount ?? estimateText(text),
    },
    finishReason: json.candidates?.[0]?.finishReason ?? null,
    raw: json,
  };
}

/* -------------------------------------------------------------------- mock */

async function mockChat(providerId, provider, req, opts = {}) {
  const modelName = String(req.model ?? 'mock');
  const behaviour = provider.mock ?? {};

  if (behaviour.failWith) {
    throw new ProviderError(behaviour.failWith, {
      code: behaviour.failCode ?? 'mock_failure',
      status: behaviour.failStatus ?? 503,
      retryable: behaviour.failRetryable ?? true,
      provider: providerId,
      model: modelName,
    });
  }
  if (/fail/.test(modelName)) {
    throw new ProviderError(`${displayName(providerId)} refused the request (simulated outage).`, {
      code: 'mock_outage',
      status: 503,
      retryable: true,
      provider: providerId,
      model: modelName,
    });
  }

  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : flattenParts(lastUser?.content);
  const delay = Number(behaviour.delayMs ?? 5);
  if (delay) await new Promise((r) => setTimeout(r, delay));

  const text = `Mock reply from ${modelName}. You said: ${prompt.slice(0, 120)}`;
  if (req.stream) {
    for (const chunk of text.match(/\S+\s*/g) ?? []) {
      opts.onToken?.(chunk);
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  return {
    text,
    usage: { prompt_tokens: estimateMessages(req.messages), completion_tokens: estimateText(text) },
    finishReason: 'stop',
    raw: { mock: true, provider: providerId },
  };
}

/* ----------------------------------------------------------------- helpers */

async function fetchJson(url, init, provider, providerId, modelName) {
  const timeoutMs = Number(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      ...init,
      body: JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new ProviderError(
      timedOut
        ? `${displayName(providerId)} took longer than ${Math.round(timeoutMs / 1000)}s to answer.`
        : `Could not reach ${displayName(providerId)}${provider.baseUrl ? ` at ${provider.baseUrl}` : ''}.`,
      {
        code: timedOut ? 'provider_timeout' : 'provider_unreachable',
        retryable: true,
        provider: providerId,
        model: modelName,
        detail: e?.message,
        cause: err,
      },
    );
  }

  if (!res.ok) {
    const detail = await safeText(res);
    // B9.4: a 429 that says when to come back is a fact worth keeping. Without
    // it we would keep knocking on a door that is closed for an hour.
    const retryAfterMs = parseRetryAfter(res.headers, detail);
    throw new ProviderError(explainHttpError(providerId, res.status, detail), {
      code: `http_${res.status}`,
      status: res.status,
      retryable: isRetryableStatus(res.status),
      provider: providerId,
      model: modelName,
      detail: detail.slice(0, 500),
      ...(retryAfterMs ? { retryAfterMs } : {}),
    });
  }
  return res;
}

/** `Retry-After` in seconds, or a reset timestamp in the error body. */
export function parseRetryAfter(headers, detail = '') {
  const header = headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  // some providers put the wait in the body instead of the header
  const body = /retry[-_ ]after[^0-9]{0,10}(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i.exec(String(detail));
  if (body) {
    const value = Number(body[1]);
    const unit = (body[2] ?? 's').toLowerCase();
    return Math.round(unit.startsWith('ms') ? value : value * 1000);
  }
  return 0;
}

/**
 * What does this provider actually serve right now?
 *
 * `/models` is part of the OpenAI-compatible surface every provider here speaks, so
 * one call answers it for all of them. The pick is deliberately dull: the first id
 * that does not look like an embedding, audio or guard model, preferring a chat
 * model over anything else. It is a recovery path, not a ranking.
 */
export async function discoverModel(providerId, provider, key, env = process.env) {
  const baseUrl = String(provider.baseUrl ?? '').replace(/\/$/, '');
  if (!baseUrl) return null;
  const headers = { accept: 'application/json' };
  const auth = sanitiseKey(key ?? (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined));
  if (auth) headers.authorization = `Bearer ${auth}`;

  try {
    const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(provider.timeoutMs ?? 10_000) });
    if (!res.ok) return null;
    const body = await res.json();
    const ids = (body?.data ?? body?.models ?? []).map((m) => m?.id ?? m?.name).filter(Boolean);
    if (!ids.length) return null;

    return pickChatModel(ids);
  } catch {
    return null;
  }
}

function explainHttpError(providerId, status, detail) {
  const name = displayName(providerId);
  if (status === 401 || status === 403) {
    return `${name} rejected the API key. Check it was copied whole and is for the right product (Groq: console.groq.com/keys, Gemini: aistudio.google.com/apikey), or unset it to use another provider.`;
  }
  if (status === 404) return `${name} does not serve that model any more — providers retire model ids, and the id in the config is stale.`;
  if (status === 429) return `${name} is rate-limiting requests right now.`;
  if (status === 402) return `${name} says the account is out of credit.`;
  if (status >= 500) return `${name} is having trouble on their side (HTTP ${status}).`;
  if (status === 400) return `${name} rejected the request (HTTP 400): ${firstLine(detail)}`;
  return `${name} returned HTTP ${status}: ${firstLine(detail)}`;
}

function isRetryableStatus(status) {
  // 400/401/403/404/422 are our fault or our credentials: retrying elsewhere is
  // still worthwhile, but the same target will not fix itself.
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function readSSE(res, onData) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          onData(JSON.parse(data));
        } catch {
          /* providers occasionally send keepalive frames; ignore them */
        }
      }
    }
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function firstLine(s) {
  return String(s ?? '').split('\n')[0].slice(0, 200);
}

function trimSlash(u) {
  return String(u ?? '').replace(/\/+$/, '');
}

function flattenParts(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p?.text ?? '').join('');
  return String(content);
}

function estimateText(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

function estimateMessages(messages) {
  return Math.max(1, Math.ceil(JSON.stringify(messages ?? '').length / 4));
}

export const __test = { explainHttpError, isRetryableStatus, estimateMessages, estimateText };
