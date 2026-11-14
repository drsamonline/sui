import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGateway, testConfig } from './helpers.js';
import { SuiClient, SuiClientError } from '@sui/sdk';

async function boot(config) {
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (gw.server.address());
  return {
    ...gw,
    client: new SuiClient({ baseUrl: `http://127.0.0.1:${port}` }),
    stop: () =>
      new Promise((resolve) => {
        gw.server.closeAllConnections?.();
        gw.server.close(() => resolve());
      }),
  };
}

test('sdk: chat returns text, usage and provenance', async () => {
  const gw = await boot(testConfig());
  const res = await gw.client.chat({ model: 'chain', messages: [{ role: 'user', content: 'hello' }] });
  assert.match(res.text, /^Mock reply from mock-a/);
  assert.equal(res.provenance.modelId, 'mock-a');
  assert.equal(res.provenance.cached, false);
  assert.ok(res.usage.prompt_tokens > 0);
  await gw.stop();
});

test('sdk: stream yields deltas and finishes with provenance', async () => {
  const gw = await boot(testConfig());
  const deltas = [];
  let provenance = null;
  for await (const chunk of gw.client.stream({ model: 'chain', messages: [{ role: 'user', content: 'stream it' }] })) {
    if (chunk.done) provenance = chunk.provenance;
    else deltas.push(chunk.delta);
  }
  assert.ok(deltas.length > 1);
  assert.match(deltas.join(''), /Mock reply/);
  assert.equal(provenance.provider, 'mock');
  await gw.stop();
});

test('sdk: models, status, metrics and health all answer', async () => {
  const gw = await boot(testConfig());
  const models = await gw.client.models();
  assert.ok(models.some((m) => m.id === 'chain'));

  const all = await gw.client.models({ all: true });
  assert.ok(all.some((m) => m.id === 'mock-a' && m.available === true));

  const status = await gw.client.status();
  assert.ok(Array.isArray(status.pool));

  const metrics = await gw.client.metrics({ since: 'all' });
  assert.ok(metrics.totals);

  const health = await gw.client.health();
  assert.equal(health.ok, true);
  await gw.stop();
});

test('sdk: a failed toggle returns blockers instead of throwing', async () => {
  const gw = await boot(testConfig());
  const result = await gw.client.validateToggle({ disableProvider: 'mock' });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.length >= 1);
  await gw.stop();
});

test('sdk: errors carry the gateway message and type', async () => {
  const gw = await boot(testConfig());
  await assert.rejects(
    () => gw.client.chat({ model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      assert.ok(err instanceof SuiClientError);
      assert.equal(err.status, 404);
      assert.match(err.message, /not a combo or model/);
      return true;
    },
  );
  await gw.stop();
});

test('sdk: a bad key is reported as 401, not as a network failure', async () => {
  const config = testConfig();
  config.apiKeys = [{ key: 'sk-right' }];
  const gw = await boot(config);
  const wrong = new SuiClient({ baseUrl: gw.client.baseUrl, apiKey: 'sk-wrong' });
  await assert.rejects(
    () => wrong.chat({ model: 'chain', messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    },
  );
  await gw.stop();
});
