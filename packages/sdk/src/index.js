/**
 * @sui/sdk — a small client for the gateway.
 *
 * No dependencies, works in Node 20+ and modern browsers. Every response keeps
 * the `sui` provenance block, because a client that cannot say who answered is
 * a client that cannot explain an outage.
 */

export class SuiClientError extends Error {
  /**
   * @param {string} message
   * @param {{type?: string, status?: number, attempts?: any[]}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SuiClientError';
    this.type = opts.type ?? 'client_error';
    this.status = opts.status ?? 0;
    this.attempts = opts.attempts ?? [];
  }
}

export class SuiClient {
  /**
   * @param {{baseUrl?: string, apiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 120000;
  }

  /** @param {string} path @param {RequestInit} [init] */
  async #request(path, init = {}) {
    const headers = {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(init.headers ?? {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new SuiClientError(
        body?.error?.message ?? `Gateway returned HTTP ${res.status}.`,
        { type: body?.error?.type, status: res.status, attempts: body?.error?.attempts },
      );
    }
    return res;
  }

  /**
   * One chat turn.
   * @param {{model: string, messages: Array<{role: string, content: string}>, temperature?: number, max_tokens?: number, top_p?: number, stop?: string|string[]}} req
   * @returns {Promise<{text: string, usage: any, provenance: any, raw: any}>}
   */
  async chat(req) {
    const res = await this.#request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...req, stream: false }),
    });
    const json = await res.json();
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      usage: json.usage ?? null,
      provenance: json.sui ?? null,
      raw: json,
    };
  }

  /**
   * Streaming turn. Yields content deltas; the last value is
   * `{done: true, provenance}`.
   * @param {{model: string, messages: Array<{role: string, content: string}>, signal?: AbortSignal}} req
   */
  async *stream(req) {
    const res = await this.#request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...req, stream: true }),
      signal: req.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let provenance = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload.sui) provenance = payload.sui;
          const delta = payload.choices?.[0]?.delta?.content;
          if (delta) yield { done: false, delta, provenance };
        }
      }
    }
    yield { done: true, provenance };
  }

  /** @param {{all?: boolean}} [opts] */
  async models(opts = {}) {
    const res = await this.#request(`/v1/models${opts.all ? '?all=1' : ''}`);
    return (await res.json()).data ?? [];
  }

  async status() {
    return (await (await this.#request('/api/status')).json());
  }

  /** @param {{since?: number|string}} [opts] */
  async metrics(opts = {}) {
    const q = opts.since != null ? `?since=${encodeURIComponent(String(opts.since))}` : '';
    return (await (await this.#request(`/api/metrics${q}`)).json());
  }

  /** Ask whether a dashboard toggle would be safe to commit. */
  async validateToggle(patch) {
    const res = await this.fetchImpl(`${this.baseUrl}/api/config/validate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(patch),
    });
    return res.json();
  }

  async health() {
    return (await (await this.#request('/healthz')).json());
  }
}

export default SuiClient;
