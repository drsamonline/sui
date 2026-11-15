/**
 * Two transports, one handler.
 *
 *   stdio  newline-delimited JSON-RPC on stdin/stdout. This is what an editor
 *          launches, and the framing is one JSON object per line — no headers,
 *          no length prefix. Anything written to stdout that is not a message
 *          breaks the peer, so logs go to stderr.
 *
 *   http   POST a JSON-RPC message, get JSON back. Stateless: every request
 *          carries everything needed to answer it.
 */

import { createInterface } from 'node:readline';

/**
 * Run the stdio loop until stdin closes.
 *
 * @param {{server: {handle: (m: any) => Promise<any>, parse: (t: string) => any}, stdin?: any, stdout?: any, stderr?: any, logger?: any}} opts
 */
export function runStdio(opts) {
  const input = opts.stdin ?? process.stdin;
  const output = opts.stdout ?? process.stdout;
  const errors = opts.stderr ?? process.stderr;
  const logger = opts.logger ?? { info() {}, warn() {} };

  const write = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };

  const rl = createInterface({ input, crlfDelay: Infinity });

  // Answers go out in the order the messages arrived, including a parse error:
  // a chain of promises is the simplest thing that cannot reorder.
  let chain = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    chain = chain.then(async () => {
      const parsed = opts.server.parse(trimmed);
      if (parsed.errorResponse) {
        write(parsed.errorResponse);
        return;
      }
      try {
        write(await opts.server.handle(parsed.message));
      } catch (err) {
        errors.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err?.message ?? err) } })}\n`);
        logger.warn?.(`stdio handler failed: ${err?.message ?? err}`);
      }
    });
  });

  return new Promise((resolve) => {
    rl.on('close', async () => {
      await chain.catch(() => {});
      resolve({ reason: 'stdin closed' });
    });
  });
}

/**
 * A Node request handler for the HTTP transport.
 *
 * @param {{server: {handle: (m: any) => Promise<any>, parse: (t: string) => any}, path?: string, logger?: any}} opts
 */
export function createHttpHandler(opts) {
  const path = opts.path ?? '/mcp';
  const logger = opts.logger ?? { info() {}, warn() {} };

  return async function handleMcpHttp(req, res, url) {
    if (url.pathname !== path) return false;

    if (req.method === 'GET') {
      // A streamable server may offer SSE here. This one answers a GET with the
      // truth: it is POST-only, and says so instead of holding the socket open.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'This MCP endpoint is POST-only. Send JSON-RPC messages as the body.' }));
      return true;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'Use POST.' }));
      return true;
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;

    const parsed = opts.server.parse(raw);
    if (parsed.errorResponse) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(parsed.errorResponse));
      return true;
    }

    try {
      const response = await opts.server.handle(parsed.message);
      if (!response) {
        // A notification has no reply; 202 says "received" without inventing one.
        res.writeHead(202);
        res.end();
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      logger.warn?.(`http mcp failed: ${err?.message ?? err}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err?.message ?? err) } }));
    }
    return true;
  };
}
