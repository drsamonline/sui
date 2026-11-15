/**
 * @sui/mcp — the Model Context Protocol server (B5.1, B5.2).
 *
 * An MCP server is a JSON-RPC 2.0 peer that advertises tools, resources and
 * prompts. This one advertises the gateway: chat, models, explain, cost,
 * compress and status. An agent that speaks MCP can use Sui without knowing it
 * is a gateway at all.
 *
 * Two transports, one message handler:
 *   stdio   newline-delimited JSON on stdin/stdout — what an editor launches
 *   http    POST a JSON-RPC message, get JSON back — what a browser or a remote
 *           agent can reach
 *
 * Version handling is honest: we offer the revisions we implement and echo the
 * client's choice when it is one of them. We do not claim a revision we have not
 * written against.
 */

import { TOOLS, callTool } from './tools.js';

/** Revisions this server implements. Ordered newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05'];
export const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const SERVER_NAME = 'sui';

export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

/**
 * @param {{gateway: any, name?: string, version?: string, logger?: any}} opts
 */
export function createMcpServer(opts) {
  const gateway = opts.gateway;
  const logger = opts.logger ?? { info() {}, warn() {} };
  let initialised = false;

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

  /**
   * Handle one JSON-RPC message. Returns a response object, or null for a
   * notification (which by definition has no reply).
   *
   * @param {any} message
   */
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail(null, ERROR_CODES.invalidRequest, 'A JSON-RPC request must be a single object.');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
      return fail(id ?? null, ERROR_CODES.invalidRequest, 'Not a JSON-RPC 2.0 request.');
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
          initialised = true;
          return ok(id, {
            protocolVersion: version,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false, subscribe: false },
              prompts: { listChanged: false },
              logging: {},
            },
            serverInfo: { name: opts.name ?? SERVER_NAME, version: opts.version ?? '0.1.0' },
            instructions:
              'Sui is a model gateway. Call sui_chat to send a prompt through a combo (a virtual model); call sui_models first if you do not know the combo names. Every answer carries provenance: which provider answered, whether it was verified, and what it cost.',
          });
        }

        case 'notifications/initialized':
          return null;

        case 'ping':
          return ok(id, {});

        case 'tools/list':
          return ok(id, { tools: TOOLS });

        case 'tools/call': {
          const name = params?.name;
          const args = params?.arguments ?? {};
          if (!name) return fail(id, ERROR_CODES.invalidParams, 'tools/call needs a tool name.');
          if (!TOOLS.some((t) => t.name === name)) {
            return fail(id, ERROR_CODES.invalidParams, `No tool called "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}.`);
          }
          const result = await callTool(name, args, gateway);
          return ok(id, result);
        }

        case 'resources/list':
          return ok(id, { resources: [] });

        case 'prompts/list':
          return ok(id, { prompts: [] });

        case 'shutdown':
          return ok(id, {});

        default:
          if (isNotification) {
            logger.warn?.(`ignoring unknown notification "${method}"`);
            return null;
          }
          return fail(id, ERROR_CODES.methodNotFound, `Unknown method "${method}".`);
      }
    } catch (err) {
      const message2 = /** @type {any} */ (err)?.message ?? String(err);
      logger.warn?.(`mcp ${method} failed: ${message2}`);
      return isNotification ? null : fail(id, ERROR_CODES.internal, message2);
    }
  }

  return {
    handle,
    get initialised() {
      return initialised;
    },
    /**
     * Parse a line or body into a message, or into a ready-to-send error
     * response. The key is `errorResponse`, not `error`: a full JSON-RPC envelope
     * is what the transport writes, and naming it `error` made it read like a
     * bare error object.
     */
    parse(text) {
      try {
        return { message: JSON.parse(text) };
      } catch {
        return { errorResponse: fail(null, ERROR_CODES.parse, 'That was not valid JSON.') };
      }
    },
  };
}
