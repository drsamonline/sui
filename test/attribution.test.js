import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGateway, testConfig, makeRouter, ask } from './helpers.js';
import { Ledger } from '@sui/telemetry';

/* --------------------------------------------------- B7.1 attribution */

test('the ledger groups cost by user and by tool, with an honest fallback', () => {
  const ledger = new Ledger({ file: null });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.002, user: 'sohil', tool: 'cline' });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.001, user: 'sohil', tool: 'aider' });
  ledger.record({ provider: 'p', modelId: 'm', ok: false, costUsd: 0, user: 'guest', tool: 'curl' });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.003 });

  const agg = ledger.aggregate({ since: 0 });
  assert.equal(agg.byUser.sohil.turns, 2);
  assert.equal(agg.byUser.sohil.costUsd, 0.003);
  assert.equal(agg.byUser.guest.failed, 1);
  assert.equal(agg.byUser.unattributed.turns, 1, 'a request with no attribution is labelled, not dropped');
  assert.deepEqual(Object.keys(agg.byTool).sort(), ['aider', 'cline', 'curl', 'unattributed']);
});

test('the CSV export carries the attribution columns', () => {
  const ledger = new Ledger({ file: null });
  ledger.record({ provider: 'p', modelId: 'm', ok: true, costUsd: 0.001, user: 'sohil', tool: 'cline' });
  const [header, row] = ledger.csv().trim().split('\n');
  assert.match(header, /,user,tool$/);
  assert.match(row, /,sohil,cline$/);
});

test('the gateway records the headers it was given', async () => {
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sui-user': 'sohil', 'x-sui-tool': 'cline', 'user-agent': 'Cline/3.1.0' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(res.status, 200);

  const agg = gw.ledger.aggregate({ since: 0 });
  assert.equal(agg.byUser.sohil.turns, 1);
  assert.equal(agg.byTool.cline.turns, 1);
  await gw.close();
});

test('without headers, the user agent becomes the tool label and the key the user', async () => {
  const config = testConfig();
  config.apiKeys = [{ name: 'team-a', key: 'sk-team-a' }];
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-team-a', 'user-agent': 'Aider/0.60 (darwin)' },
    body: JSON.stringify({ model: 'chain', messages: [{ role: 'user', content: 'hello' }] }),
  });

  const agg = gw.ledger.aggregate({ since: 0 });
  assert.equal(agg.byUser['team-a'].turns, 1, 'the key name is the best available label for who');
  assert.equal(agg.byTool.Aider.turns, 1, 'the product, not the whole user agent string');
  await gw.close();
});

/* ------------------------------------------------- B6.4 privacy reporting */

test('/api/status reports each provider privacy posture and the tiers it clears', async () => {
  const config = testConfig();
  config.providers.trainer = { type: 'mock', privacy: { retention: 'long', trainsOnData: true } };
  config.providers.clean = { type: 'mock', privacy: { retention: 'session', trainsOnData: false } };
  config.models['t-1'] = { provider: 'trainer', model: 't', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.models['c-1'] = { provider: 'clean', model: 'c', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.combos.c = { strategy: 'fallback', targets: ['t-1', 'c-1'] };
  config.privacy = { defaultTier: 'strict' };

  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.equal(status.privacy.defaultTier, 'strict');

  const trainer = status.privacy.providers.find((p) => p.id === 'trainer');
  assert.equal(trainer.trainsOnData, true);
  assert.equal(trainer.tiers.standard, false);
  assert.equal(trainer.tiers.strict, false);

  const clean = status.privacy.providers.find((p) => p.id === 'clean');
  assert.equal(clean.tiers.standard, true);
  assert.equal(clean.tiers.strict, true);
  await gw.close();
});
