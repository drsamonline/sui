/**
 * @drsamonline/mcp/client — Sui calling other MCP servers (B5.4).
 *
 * The other direction from `server.js`. An MCP server that exposes a tool is,
 * from the gateway's point of view, another provider: it takes a prompt and
 * returns text. So it becomes one — `type: "mcp"` — and every rule the router
 * already enforces (breaker, budget, privacy tier, canary, verification) applies
 * to it without a single special case.
 *
 * Two transports, matching the server side: `http` for a URL, `stdio` for a
 * command the gateway launches.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A minimal JSON-RPC client for one MCP server.
 */
export class McpClient {
  /**
   * @param {{id: string, transport: 'http'|'stdio', url?: string, command?: string, args?: string[], env?: any, timeoutMs?: number, fetchImpl?: typeof fetch, now?: () => number}} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.transport = opts.transport ?? (opts.url ? 'http' : 'stdio');
    this.url = opts.url;
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.env = opts.env ?? process.env;
    this.timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;

    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map();
    this.child = null;
    this.buffer = '';
    this.ready = false;
    this.serverInfo = null;
    this.tools = [];
  }

  /** @param {{protocolVersion?: string}} [opts] */
  async connect(opts = {}) {
    if (this.ready) return this;

    if (this.transport === 'stdio') {
      if (!this.command) throw new Error(`MCP client "${this.id}" needs a command for the stdio transport.`);
      this.child = spawn(this.command, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });

      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (line) this.#onMessage(line);
        }
      });
      // stderr is logs, never protocol
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', () => {});

      this.child.on('exit', (code) => {
        this.ready = false;
        for (const [id, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`MCP server "${this.id}" exited (code ${code}) before answering request ${id}.`));
        }
        this.pending.clear();
      });
    }

    const init = await this.request('initialize', {
      protocolVersion: opts.protocolVersion ?? '2024-11-05',
      clientInfo: { name: 'sui', version: '0.1.0' },
      capabilities: {},
    });

    this.serverInfo = init?.serverInfo ?? null;
    this.ready = true;
    this.notify('notifications/initialized');

    const listed = await this.request('tools/list', {});
    this.tools = listed?.tools ?? [];
    return this;
  }

  /** @param {string} line */
  #onMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a non-JSON line is a log the peer should not have written; ignore it
    }
    if (message.id == null) return; // a notification from the server
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? 'MCP error'), { code: message.error.code }));
    else waiter.resolve(message.result);
  }

  /**
   * @param {string} method
   * @param {any} params
   */
  async request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    if (this.transport === 'http') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`MCP server "${this.id}" answered ${res.status}.`);
        const json = await res.json();
        if (json.error) throw Object.assign(new Error(json.error.message ?? 'MCP error'), { code: json.error.code });
        return json.result;
      } finally {
        clearTimeout(timer);
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.id}" did not answer ${method} within ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** @param {string} method @param {any} [params] */
  notify(method, params) {
    const payload = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (this.transport === 'stdio' && this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  /** @param {string} name @param {any} args */
  async callTool(name, args) {
    if (!this.ready) await this.connect();
    const result = await this.request('tools/call', { name, arguments: args ?? {} });
    const text = (result?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return { text, isError: Boolean(result?.isError), structured: result?.structuredContent ?? null, raw: result };
  }

  async close() {
    this.ready = false;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP client "${this.id}" closed.`));
    }
    this.pending.clear();
    if (this.child) {
      this.child.stdin?.end();
      this.child.kill();
      this.child = null;
    }
  }
}
