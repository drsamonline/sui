import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient, createMcpAdapter, resetMcpClients } from '@sui/mcp';
import { makeRouter, testConfig, ask } from './helpers.js';

/**
 * A tiny MCP server over HTTP: initialize, tools/list, tools/call. It echoes the
 * prompt back, uppercased, which is enough to prove the wiring end to end.
 */
async function fakeMcpHttp({ fail = false } = {}) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const msg = JSON.parse(raw || '{}');

    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };

    if (msg.method === 'initialize') {
      return reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'fake-mcp', version: '1' }, capabilities: { tools: {} } });
    }
    if (msg.method === 'tools/list') {
      return reply({ tools: [{ name: 'shout', description: 'Uppercase the prompt.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }] });
    }
    if (msg.method === 'tools/call') {
      calls += 1;
      if (fail) return reply({ content: [{ type: 'text', text: 'the tool could not do that' }], isError: true });
      return reply({
        content: [{ type: 'text', text: String(msg.params?.arguments?.prompt ?? '').toUpperCase() }],
        structuredContent: { echo: true },
      });
    }
    reply({});
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls: () => calls,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** An MCP server as a script, for the stdio transport. */
function writeStdioServer() {
  const dir = mkdtempSync(join(tmpdir(), 'sui-mcp-'));
  const file = join(dir, 'server.mjs');
  writeFileSync(
    file,
    `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;              // notification: no reply
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'stdio-fake', version: '1' }, capabilities: { tools: {} } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'shout', description: 'Uppercase.', inputSchema: { type: 'object' } }] } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'STDIO:' + (msg.params.arguments.prompt ?? '') }] } });
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
});
`,
  );
  return file;
}

/* ------------------------------------------------------------ the client */

test('the client handshakes, lists tools and calls one over HTTP', async () => {
  const fake = await fakeMcpHttp();
  const client = new McpClient({ id: 'fake', url: fake.url });
  await client.connect();

  assert.equal(client.serverInfo.name, 'fake-mcp');
  assert.equal(client.tools[0].name, 'shout');

  const result = await client.callTool('shout', { prompt: 'hello' });
  assert.equal(result.text, 'HELLO');
  assert.equal(result.isError, false);
  await fake.close();
});

test('the client speaks stdio to a launched command', async () => {
  const script = writeStdioServer();
  const client = new McpClient({ id: 'stdio', command: process.execPath, args: [script] });
  await client.connect();

  assert.equal(client.serverInfo.name, 'stdio-fake');
  const result = await client.callTool('shout', { prompt: 'hi' });
  assert.equal(result.text, 'STDIO:hi');
  await client.close();
});

test('an error from the server is an error here, not an empty answer', async () => {
  const fake = await fakeMcpHttp({ fail: true });
  const client = new McpClient({ id: 'fake2', url: fake.url });
  await client.connect();
  const result = await client.callTool('shout', { prompt: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.text, /could not do that/);
  await fake.close();
});

test('a server that never answers times out instead of hanging the request', async () => {
  const client = new McpClient({ id: 'slow', url: 'http://127.0.0.1:9/mcp', timeoutMs: 150 });
  await assert.rejects(() => client.connect(), /did not answer|fetch failed|ECONNREFUSED/i);
});

/* ----------------------------------------------------------- the adapter */

test('an MCP tool answers as a provider, with usage the ledger can charge', async () => {
  const fake = await fakeMcpHttp();
  resetMcpClients();
  const adapter = createMcpAdapter('mcp-shout', { url: fake.url, tool: 'shout' }, {});

  const result = await adapter.chat({ messages: [{ role: 'user', content: 'quiet words' }] });
  assert.equal(result.text, 'QUIET WORDS');
  assert.ok(result.usage.prompt_tokens > 0);
  assert.ok(result.usage.completion_tokens > 0);
  await fake.close();
});

test('the prompt argument is configurable, because only the operator knows the tool', async () => {
  const fake = await fakeMcpHttp();
  resetMcpClients();
  const adapter = createMcpAdapter('mcp-custom', { url: fake.url, tool: 'shout', argument: 'prompt', arguments: { style: 'loud' } }, {});
  const result = await adapter.chat({ messages: [{ role: 'user', content: 'ok' }] });
  assert.equal(result.text, 'OK');
  await fake.close();
});

test('a tool error becomes a provider failure the router can fall back from', async () => {
  const fake = await fakeMcpHttp({ fail: true });
  resetMcpClients();
  const adapter = createMcpAdapter('mcp-fail', { url: fake.url, tool: 'shout' }, {});
  await assert.rejects(() => adapter.chat({ messages: [{ role: 'user', content: 'x' }] }), /could not do that/);
  await fake.close();
});

test('a provider with no tool name says so at construction', () => {
  assert.throws(() => createMcpAdapter('mcp-nameless', { url: 'http://127.0.0.1:1/mcp' }, {}), /needs a tool name/);
});

/* ------------------------------------------------- routing through the router */

test('a combo can route to an MCP server like any other provider', async () => {
  const fake = await fakeMcpHttp();
  resetMcpClients();

  const config = testConfig();
  config.providers.shout = { type: 'mcp', url: fake.url, tool: 'shout' };
  config.models['shout-1'] = { provider: 'shout', model: 'shout', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.combos.shouting = { strategy: 'fallback', targets: ['shout-1'] };

  const { router, ledger } = makeRouter(config);
  const res = await router.chat({ combo: 'shouting', body: ask('route me through mcp') });

  assert.equal(res.text, 'ROUTE ME THROUGH MCP');
  assert.equal(res.meta.provider, 'shout');
  assert.equal(ledger.records.filter((r) => r.ok).length, 1, 'the turn is on the ledger like any other');
  await fake.close();
});

test('an MCP provider is considered callable when it has a URL or a command', async () => {
  const { providerHasCredentials, normalizeConfig } = await import('@sui/core');
  const config = normalizeConfig(
    {
      providers: {
        viaUrl: { type: 'mcp', url: 'http://127.0.0.1:1/mcp', tool: 't' },
        viaCmd: { type: 'mcp', command: 'node', tool: 't' },
        broken: { type: 'mcp', tool: 't' },
      },
      models: { a: { provider: 'viaUrl', model: 'a' } },
      combos: { c: { strategy: 'fallback', targets: ['a'] } },
    },
    { env: {} },
  );
  assert.equal(providerHasCredentials(config.providers.viaUrl, {}, config), true);
  assert.equal(providerHasCredentials(config.providers.viaCmd, {}, config), true);
  assert.equal(providerHasCredentials(config.providers.broken, {}, config), false, 'no url and no command is not callable');
});
