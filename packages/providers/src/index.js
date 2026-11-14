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

import { ProviderError } from '@sui/core';

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
export function createAdapter(providerId, provider, env = process.env) {
  const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined);
  const base = { id: providerId, type: provider.type, name: displayName(providerId), hasKey: Boolean(apiKey) };

  if (provider.type === 'openai') {
    return { ...base, chat: (req, opts) => openaiChat(providerId, provider, apiKey, req, opts) };
  }
  if (provider.type === 'anthropic') {
    return { ...base, chat: (req, opts) => anthropicChat(providerId, provider, apiKey, req, opts) };
  }
  if (provider.type === 'gemini') {
    return { ...base, chat: (req, opts) => geminiChat(providerId, provider, apiKey, req, opts) };
  }
  if (provider.type === 'mock') {
    return { ...base, chat: (req, opts) => mockChat(providerId, provider, req, opts) };
  }
  throw new ProviderError(`Provider "${providerId}" has an unknown type "${provider.type}".`, {
    code: 'bad_provider_type',
    provider: providerId,
  });
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
  const text = choice?.message?.content ?? '';
  return {
    text: typeof text === 'string' ? text : flattenParts(text),
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
  if (system) body.system = system;
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
    throw new ProviderError(explainHttpError(providerId, res.status, detail), {
      code: `http_${res.status}`,
      status: res.status,
      retryable: isRetryableStatus(res.status),
      provider: providerId,
      model: modelName,
      detail: detail.slice(0, 500),
    });
  }
  return res;
}

function explainHttpError(providerId, status, detail) {
  const name = displayName(providerId);
  if (status === 401 || status === 403) return `${name} rejected the API key.`;
  if (status === 404) return `${name} says that model does not exist.`;
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
