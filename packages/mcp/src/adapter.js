/**
 * An MCP server as a provider adapter (B5.4).
 *
 * The contract is the same one every other adapter honours: take messages, return
 * text plus usage. What makes this worth doing is that everything upstream —
 * fallback, breakers, budgets, privacy tiers, canary, verification, the ledger —
 * then applies to an MCP tool for free.
 */

import { McpClient } from './client.js';

/** @type {Map<string, McpClient>} */
const clients = new Map();

/**
 * @param {string} providerId
 * @param {any} provider
 * @param {NodeJS.ProcessEnv} [env]
 */
export function mcpClientFor(providerId, provider, env = process.env) {
  const key = `${providerId}:${provider.transport ?? (provider.url ? 'http' : 'stdio')}:${provider.url ?? provider.command}`;
  let client = clients.get(key);
  if (!client) {
    client = new McpClient({
      id: providerId,
      transport: provider.transport ?? (provider.url ? 'http' : 'stdio'),
      url: provider.url,
      command: provider.command,
      args: provider.args ?? [],
      timeoutMs: provider.timeoutMs,
      env,
    });
    clients.set(key, client);
  }
  return client;
}

/** Drop a cached client — used when a provider is edited or a test ends. */
export function resetMcpClients() {
  for (const client of clients.values()) client.close().catch(() => {});
  clients.clear();
}

/**
 * Build the adapter. The tool name and the argument mapping come from the
 * provider config, because only the operator knows what their tool expects.
 *
 * @param {string} providerId
 * @param {any} provider
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createMcpAdapter(providerId, provider, env = process.env) {
  const tool = provider.tool;
  if (!tool) {
    throw new Error(`MCP provider "${providerId}" needs a tool name — which tool should answer a chat request?`);
  }

  return {
    id: providerId,
    type: 'mcp',
    name: provider.label ?? providerId,
    hasKey: true,

    /**
     * @param {{messages: Array<{role: string, content: string}>, max_tokens?: number}} req
     */
    async chat(req) {
      const client = mcpClientFor(providerId, provider, env);
      const messages = req.messages ?? [];
      const prompt = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

      // `argument` lets an operator put the prompt under whatever key their tool
      // wants; everything else is passed through as configured.
      const args = { ...(provider.arguments ?? {}) };
      args[provider.argument ?? 'prompt'] = prompt;
      if (system && provider.systemArgument) args[provider.systemArgument] = system;
      if (req.max_tokens && provider.maxTokensArgument) args[provider.maxTokensArgument] = req.max_tokens;

      const result = await client.callTool(tool, args);
      if (result.isError) {
        // A tool error is a provider failure, with the tool's own words.
        const error = new Error(result.text || `MCP tool "${tool}" reported an error.`);
        /** @type {any} */ (error).status = 502;
        throw error;
      }

      const text = result.text;
      return {
        text,
        usage: {
          // An MCP tool reports no tokens, so we estimate and say so in the docs.
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(text.length / 4),
        },
        finishReason: 'stop',
        raw: result.raw,
      };
    },
  };
}
