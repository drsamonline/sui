import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaneGuard, createModelPlaneClient, describePlane, planePolicy, tokenMatches } from '../apps/gateway/src/planes.js';
import { makeGateway, testConfig } from './helpers.js';

const TOKEN = 'plane-secret-1';

function modelConfig(extra = {}) {
  const config = testConfig();
  config.planes = { role: 'model', modelPlaneUrl: null, serviceTokenEnv: 'SUI_PLANE_TOKEN' };
  config.env = { ...config.env, SUI_PLANE_TOKEN: TOKEN };
  return { ...config, ...extra };
}

function agentConfig(modelPlaneUrl, extra = {}) {
  const config = testConfig();
  config.planes = { role: 'agent', modelPlaneUrl, serviceTokenEnv: 'SUI_PLANE_TOKEN' };
  config.env = { ...config.env, SUI_PLANE_TOKEN: TOKEN };
  return { ...config, ...extra };
}

async function boot(config, env = {}) {
  // the gateway reads its environment at startup; config.env is not consulted
  const gw = await makeGateway(config, { env: { ...process.env, SUI_PLANE_TOKEN: TOKEN, ...env } });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  return { gw, base: `http://127.0.0.1:${port}` };
}

/* ----------------------------------------------------------- the policy */

test('the two roles serve different surfaces', () => {
  const model = planePolicy('model');
  const agent = planePolicy('agent');

  assert.equal(model.serves.chat, true);
  assert.equal(model.serves.runs, false, 'runs belong to the agent plane');
  assert.equal(model.holdsProviderCredentials, true);

  assert.equal(agent.serves.chat, true, 'the agent plane serves chat by forwarding it');
  assert.equal(agent.serves.models, false, 'but it has no model list of its own');
  assert.equal(agent.serves.runs, true);
  assert.equal(agent.holdsProviderCredentials, false);
  assert.equal(agent.agentFacing, true);
});

test('both means both, so an existing deployment keeps working', () => {
  const both = planePolicy('both');
  assert.equal(both.serves.chat, true);
  assert.equal(both.serves.runs, true);
});

test('token comparison is length-safe and constant-time', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', 'abcdef'), false);
  assert.equal(tokenMatches('', ''), false, 'an empty expected token never matches');
  assert.equal(tokenMatches(undefined, 'x'), false);
});

/* ------------------------------------------------------------ the guard */

test('the model plane refuses a request with no token, and says who may call', () => {
  const guard = createPlaneGuard({ serviceToken: TOKEN, role: 'model' });
  const denied = guard.check({ headers: {} }, '/v1/chat/completions');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.match(denied.message, /serves only the agent plane/);

  const allowed = guard.check({ headers: { 'x-sui-plane-token': TOKEN } }, '/v1/chat/completions');
  assert.equal(allowed.ok, true);
});

test('health and status stay open, because a probe cannot hold a secret', () => {
  const guard = createPlaneGuard({ serviceToken: TOKEN, role: 'model' });
  assert.equal(guard.check({ headers: {} }, '/health').ok, true);
  assert.equal(guard.check({ headers: {} }, '/api/status').ok, true);
});

test('the model plane does not serve the agent surface, token or not', () => {
  const guard = createPlaneGuard({ serviceToken: TOKEN, role: 'model' });
  const runs = guard.check({ headers: { 'x-sui-plane-token': TOKEN } }, '/api/runs');
  assert.equal(runs.ok, false);
  assert.equal(runs.code, 'not_this_plane');
});

/* ------------------------------------------------- end to end, two planes */

test('the agent plane forwards to the model plane and returns its answer', async () => {
  const model = await boot(modelConfig());

  const res = await fetch(`${model.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sui-plane-token': TOKEN },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hello from the model plane' }] }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).choices[0].message.content, /Mock reply/);

  // now the agent plane, pointed at it
  const agent = await boot(agentConfig(model.base));
  const viaAgent = await fetch(`${agent.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hello via the agent plane' }] }),
  });

  assert.equal(viaAgent.status, 200);
  const body = await viaAgent.json();
  assert.match(body.choices[0].message.content, /Mock reply/);

  await agent.gw.close();
  await model.gw.close();
});

test('the model plane rejects a direct caller without the token', async () => {
  const model = await boot(modelConfig());
  const res = await fetch(`${model.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'sneaky' }] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.type, 'plane_token_required');
  await model.gw.close();
});

test('run bounds are enforced on the agent plane, before anything is forwarded', async () => {
  const model = await boot(modelConfig());
  const agent = await boot(agentConfig(model.base));

  await fetch(`${agent.base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'bounded', limits: { maxSteps: 1 } }),
  });

  const call = (text) =>
    fetch(`${agent.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sui-run': 'bounded' },
      body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: text }] }),
    });

  assert.equal((await call('one')).status, 200);
  const denied = await call('two');
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.type, 'run_bounded');

  await agent.gw.close();
  await model.gw.close();
});

test('an agent plane with no modelPlaneUrl says so instead of pretending', async () => {
  const config = testConfig();
  config.planes = { role: 'agent', modelPlaneUrl: null, serviceTokenEnv: 'SUI_PLANE_TOKEN' };
  config.env = { ...config.env, SUI_PLANE_TOKEN: TOKEN };
  const agent = await boot(config);

  const res = await fetch(`${agent.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.type, 'model_plane_not_configured');
  await agent.gw.close();
});

test('an unreachable model plane is a 502 that names the address', async () => {
  const client = createModelPlaneClient({ modelPlaneUrl: 'http://127.0.0.1:9', serviceToken: TOKEN, timeoutMs: 300 });
  const result = await client.forward({ path: '/v1/chat/completions', method: 'POST', body: {} });
  assert.equal(result.status, 502);
  assert.match(result.json.error.message, /127\.0\.0\.1:9|model plane/i);
});

test('status describes the topology, including who holds the keys', async () => {
  const model = await boot(modelConfig());
  const status = await (await fetch(`${model.base}/api/status`)).json();
  assert.equal(status.planes.role, 'model');
  assert.equal(status.planes.holdsProviderCredentials, true);
  assert.equal(status.planes.agentFacing, false);
  assert.equal(status.planes.serviceTokenConfigured, true);
  await model.gw.close();
});

test('describePlane reports what it was told, not what it assumes', () => {
  const described = describePlane({ role: 'agent', modelPlaneUrl: 'http://127.0.0.1:8787', hasServiceToken: false });
  assert.equal(described.holdsProviderCredentials, false);
  assert.equal(described.serviceTokenConfigured, false);
  assert.equal(described.modelPlaneUrl, 'http://127.0.0.1:8787');
});

test('an unknown role is refused rather than defaulted to both', () => {
  assert.throws(() => planePolicy('agentplane'), /Unknown plane role/);
});
