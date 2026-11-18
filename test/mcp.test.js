import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMcpServer, createHttpHandler, runStdio, TOOLS, PROTOCOL_VERSION } from '@drsamonline/mcp';
import { makeGateway, testConfig } from './helpers.js';

async function boot() {
  const gw = await makeGateway(testConfig());
  return { gw, server: createMcpServer({ gateway: gw }) };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

/* ------------------------------------------------------- the handshake */

test('initialize negotiates a version it actually implements', async () => {
  const { gw, server } = await boot();
  const res = await server.handle(rpc(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'test', version: '1' } }));

  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(res.result.serverInfo.name, 'sui');
  assert.equal(typeof res.result.capabilities.tools, 'object');
  assert.match(res.result.instructions, /sui_chat/);
  await gw.close();
});

test('a version we do not implement gets ours back, not a lie', async () => {
  const { gw, server } = await boot();
  const res = await server.handle(rpc(1, 'initialize', { protocolVersion: '2099-01-01' }));
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  await gw.close();
});

test('a notification gets no reply at all', async () => {
  const { gw, server } = await boot();
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'some/unknown/notification' }), null);
  await gw.close();
});

/* --------------------------------------------------------------- tools */

test('tools/list advertises schemas a client can validate against', async () => {
  const { gw, server } = await boot();
  const res = await server.handle(rpc(2, 'tools/list'));
  const tools = res.result.tools;

  assert.equal(tools.length, TOOLS.length);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
    assert.equal(tool.inputSchema.type, 'object');
  }
  const chat = tools.find((t) => t.name === 'sui_chat');
  assert.deepEqual(chat.inputSchema.required, ['prompt']);
  await gw.close();
});

test('sui_chat answers through the gateway and returns provenance', async () => {
  const { gw, server } = await boot();
  const res = await server.handle(rpc(3, 'tools/call', { name: 'sui_chat', arguments: { prompt: 'hello', combo: 'chain' } }));

  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /Mock reply/);
  assert.equal(res.result.structuredContent.combo, 'chain');
  assert.equal(typeof res.result.structuredContent.latencyMs, 'number');
  await gw.close();
});

test('a gateway failure comes back as a tool error with the gateway sentence', async () => {
  const { gw, server } = await boot();
  const res = await server.handle(rpc(4, 'tools/call', { name: 'sui_chat', arguments: { prompt: 'hello', combo: 'nope' } }));
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown model/);
  await gw.close();
});

test('the read-only tools answer without sending a request', async () => {
  const { gw, server } = await boot();
  const before = gw.ledger.records.length;

  const models = await server.handle(rpc(5, 'tools/call', { name: 'sui_models', arguments: {} }));
  assert.ok(models.result.structuredContent.combos.length > 0);

  const explain = await server.handle(rpc(6, 'tools/call', { name: 'sui_explain', arguments: { combo: 'chain' } }));
  assert.ok(explain.result.content[0].text.includes('fallback route'));

  const cost = await server.handle(rpc(7, 'tools/call', { name: 'sui_cost', arguments: {} }));
  assert.equal(typeof cost.result.structuredContent.spentUsd, 'number');

  const status = await server.handle(rpc(8, 'tools/call', { name: 'sui_status', arguments: {} }));
  assert.equal(typeof status.result.structuredContent.privacy.defaultTier, 'string');

  const compress = await server.handle(rpc(9, 'tools/call', { name: 'sui_compress', arguments: { text: 'prose '.repeat(80), preset: 'aggressive' } }));
  assert.ok(compress.result.structuredContent.ratio >= 0);

  assert.equal(gw.ledger.records.length, before, 'no provider was called by a read-only tool');
  await gw.close();
});

/* ------------------------------------------------------------ errors */

test('unknown methods, unknown tools and bad JSON each get the right code', async () => {
  const { gw, server } = await boot();
  assert.equal((await server.handle(rpc(10, 'nope/nope'))).error.code, -32601);
  assert.equal((await server.handle(rpc(11, 'tools/call', { name: 'ghost', arguments: {} }))).error.code, -32602);
  assert.equal(server.parse('{not json').errorResponse.error.code, -32700);
  assert.equal((await server.handle({ jsonrpc: '1.0', id: 12, method: 'ping' })).error.code, -32600);
  await gw.close();
});

test('ping answers, because a client uses it to check the pipe', async () => {
  const { gw, server } = await boot();
  const res = await server.handle(rpc(13, 'ping'));
  assert.deepEqual(res.result, {});
  await gw.close();
});

/* --------------------------------------------------------- transports */

test('stdio speaks newline-delimited JSON and writes nothing else to stdout', async () => {
  const { gw, server } = await boot();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let out = '';
  stdout.on('data', (d) => (out += d));
  const done = runStdio({ server, stdin, stdout, stderr });

  stdin.write(`${JSON.stringify(rpc(1, 'initialize', { protocolVersion: PROTOCOL_VERSION }))}\n`);
  stdin.write(`${JSON.stringify(rpc(2, 'tools/list'))}\n`);
  stdin.write('not json\n');
  stdin.end();

  await done;
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, 'one response per line, including the parse error');
  assert.equal(lines[0].result.serverInfo.name, 'sui');
  assert.equal(lines[1].result.tools.length, TOOLS.length);
  assert.equal(lines[2].error.code, -32700);
  await gw.close();
});

test('the HTTP transport answers POST, refuses GET with a reason, and 202s a notification', async () => {
  const { gw, server } = await boot();
  const handle = createHttpHandler({ server });
  const url = new URL('http://localhost/mcp');

  const call = async (method, body, path = '/mcp') => {
    const req = { method, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body ?? ''); } };
    const res = {
      status: null,
      headers: null,
      body: '',
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(chunk) {
        this.body = chunk ? String(chunk) : '';
      },
    };
    const handled = await handle(req, res, new URL(`http://localhost${path}`));
    return { handled, res };
  };

  const ok = await call('POST', JSON.stringify(rpc(1, 'initialize', { protocolVersion: PROTOCOL_VERSION })));
  assert.equal(ok.res.status, 200);
  assert.equal(JSON.parse(ok.res.body).result.serverInfo.name, 'sui');

  const get = await call('GET');
  assert.equal(get.res.status, 405);
  assert.match(JSON.parse(get.res.body).error, /POST-only/);

  const note = await call('POST', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.res.status, 202);
  assert.equal(note.res.body, '');

  const elsewhere = await handle({ method: 'POST' }, {}, new URL('http://localhost/other'));
  assert.equal(elsewhere, false, 'the handler declines paths it does not own');
  await gw.close();
});
