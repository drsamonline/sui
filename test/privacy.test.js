import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIVACY_TIERS, privacyRefusal, providerMeetsPrivacyTier } from '@sui/core';
import { makeRouter, makeGateway, testConfig, ask } from './helpers.js';
import { hashApiKey } from '@sui/core';

/* ---------------------------------------------------------- the tier rules */

test('the three tiers are any, standard and strict', () => {
  assert.deepEqual(PRIVACY_TIERS, ['any', 'standard', 'strict']);
});

test('any accepts everything, including a provider that trains on your data', () => {
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'long', trainsOnData: true } }, 'any'), true);
  assert.equal(providerMeetsPrivacyTier(undefined, 'any'), true);
});

test('standard refuses only providers that train on your data', () => {
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'long', trainsOnData: true } }, 'standard'), false);
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'long', trainsOnData: false } }, 'standard'), true);
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'unknown' } }, 'standard'), true, 'unknown is allowed at standard');
});

test('strict needs retention none or session, and unknown is not good enough', () => {
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'none' } }, 'strict'), true);
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'session' } }, 'strict'), true);
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'short' } }, 'strict'), false);
  assert.equal(providerMeetsPrivacyTier({ privacy: { retention: 'unknown' } }, 'strict'), false);
  assert.equal(providerMeetsPrivacyTier({}, 'strict'), false);
});

test('a refusal names the reason, not just the failure', () => {
  assert.match(privacyRefusal({ privacy: { trainsOnData: true } }, 'standard'), /train on your data/);
  assert.match(privacyRefusal({ privacy: { retention: 'long' } }, 'strict'), /retention none or session.*"long"/);
});

/* ------------------------------------------------------------ the routing */

function privacyConfig() {
  const config = testConfig();
  config.providers.trainer = { type: 'mock', mock: { delayMs: 1 }, privacy: { retention: 'long', trainsOnData: true } };
  config.providers.clean = { type: 'mock', mock: { delayMs: 1 }, privacy: { retention: 'session', trainsOnData: false } };
  config.providers.unmarked = { type: 'mock', mock: { delayMs: 1 } }; // posture unknown
  config.models['trainer-1'] = { provider: 'trainer', model: 'trainer-model', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.models['clean-1'] = { provider: 'clean', model: 'clean-model', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.models['unmarked-1'] = { provider: 'unmarked', model: 'unmarked-model', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.combos.mixed = { strategy: 'fallback', targets: ['trainer-1', 'unmarked-1', 'clean-1'] };
  return config;
}

test('standard skips the training provider and answers from the next one', async () => {
  const { router } = makeRouter(privacyConfig());
  const res = await router.chat({ combo: 'mixed', body: ask('hello'), privacyTier: 'standard' });
  assert.equal(res.meta.modelId, 'unmarked-1', 'unknown posture is acceptable at standard');
  assert.equal(res.meta.route.privacyTier, 'standard');
});

test('strict skips both the trainer and the unmarked provider', async () => {
  const { router } = makeRouter(privacyConfig());
  const res = await router.chat({ combo: 'mixed', body: ask('hello'), privacyTier: 'strict' });
  assert.equal(res.meta.modelId, 'clean-1');
  const reasons = res.meta.route.considered.filter((c) => c.outcome === 'skipped').map((c) => c.reason);
  assert.ok(reasons.some((r) => /train on your data/.test(r)));
  assert.ok(reasons.some((r) => /retention none or session/.test(r)));
});

test('a strict request with nothing eligible fails closed rather than downgrading', async () => {
  const config = privacyConfig();
  config.combos.mixed.targets = ['trainer-1', 'unmarked-1'];
  const { router } = makeRouter(config);

  await assert.rejects(
    () => router.chat({ combo: 'mixed', body: ask('hello'), privacyTier: 'strict' }),
    (err) => {
      assert.equal(err.code, 'no_route_available');
      assert.match(err.message, /privacy tier|train on your data|retention none or session/);
      return true;
    },
  );
});

test('the default tier is any, so nothing changes for existing configs', async () => {
  const { router } = makeRouter(privacyConfig());
  const res = await router.chat({ combo: 'mixed', body: ask('hello') });
  assert.equal(res.meta.modelId, 'trainer-1', 'the first declared target answers when no tier is set');
  assert.equal(res.meta.route.privacyTier, 'any');
});

/* -------------------------------------------------------------- over HTTP */

test('the x-sui-privacy header sets the tier, and an unknown tier is a 400', async () => {
  const config = privacyConfig();
  config.apiKeys = [{ name: 'k', key_hash: hashApiKey('sk-k') }];
  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const call = (tier) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-k', 'x-sui-privacy': tier },
      body: JSON.stringify({ model: 'mixed', messages: [{ role: 'user', content: 'hello' }] }),
    });

  const strict = await (await call('strict')).json();
  assert.equal(strict.sui.modelId, 'clean-1');

  const bad = await call('paranoid');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.type, 'bad_privacy_tier');
  await gw.close();
});

/* ------------------------------------------------- B6.6 residency */

test('a region requirement excludes providers outside it, with the reason', async () => {
  const { providerMeetsRegion, regionRefusal, REGIONS } = await import('@sui/core');
  assert.deepEqual(REGIONS.slice(0, 3), ['any', 'eu', 'us']);
  assert.equal(providerMeetsRegion({ region: 'eu' }, 'eu'), true);
  assert.equal(providerMeetsRegion({ region: 'us' }, 'eu'), false);
  assert.equal(providerMeetsRegion({}, 'eu'), false, 'an unmarked provider cannot satisfy residency');
  assert.equal(providerMeetsRegion({ region: 'us' }, 'any'), true);
  assert.match(regionRefusal({ region: 'us' }, 'eu'), /requires region "eu".*is "us"/);
});

test('the router honours a region on the request, and fails closed', async () => {
  const config = privacyConfig();
  config.providers.trainer.region = 'us';
  config.providers.clean.region = 'eu';
  const { router } = makeRouter(config);

  const inEu = await router.chat({ combo: 'mixed', body: ask('hello'), region: 'eu', privacyTier: 'any' });
  assert.equal(inEu.meta.modelId, 'clean-1', 'only the EU provider may answer');
  assert.equal(inEu.meta.route.region, 'eu');

  await assert.rejects(
    () => router.chat({ combo: 'mixed', body: ask('hello'), region: 'in', privacyTier: 'any' }),
    (err) => {
      assert.equal(err.code, 'no_route_available');
      assert.match(err.message, /residency requires region "in"/);
      return true;
    },
    'nothing in India, so nothing answers',
  );
});

test('the x-sui-region header sets the requirement, and an unknown region is a 400', async () => {
  const config = privacyConfig();
  config.providers.trainer.region = 'us';
  config.providers.clean.region = 'eu';
  config.providers.unmarked.region = 'eu';
  config.apiKeys = [{ name: 'k', key_hash: hashApiKey('sk-k') }];

  const gw = await makeGateway(config);
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const call = (region) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-k', 'x-sui-region': region },
      body: JSON.stringify({ model: 'mixed', messages: [{ role: 'user', content: 'hello' }] }),
    });

  const eu = await (await call('eu')).json();
  assert.ok(['clean-1', 'unmarked-1'].includes(eu.sui.modelId), 'an EU provider answered');
  assert.equal(eu.sui.route.region, 'eu');

  const bad = await call('mars');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.type, 'bad_region');
  await gw.close();
});
