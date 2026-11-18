import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { clearToken, createAdapter, cachedToken, refreshAccessToken } from '@drsamonline/providers';

/**
 * A provider that 401s until the right bearer arrives, plus a token endpoint that
 * hands it out. Both local, both counted.
 */
async function fakeOauth({ validToken = 'tok-1', refreshStatus = 200 } = {}) {
  let tokenCalls = 0;
  let apiCalls = 0;

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;

    if (req.url === '/token') {
      tokenCalls += 1;
      if (refreshStatus !== 200) {
        res.writeHead(refreshStatus, { 'content-type': 'application/json' });
        res.end('{"error":"invalid_grant"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: validToken, expires_in: 3600 }));
      return;
    }

    apiCalls += 1;
    const auth = String(req.headers.authorization ?? '').replace('Bearer ', '');
    if (auth !== validToken) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"token expired"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    tokenCalls: () => tokenCalls,
    apiCalls: () => apiCalls,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const env = { OAUTH_ID: 'client-1', OAUTH_SECRET: 'shh', OAUTH_REFRESH: 'refresh-1' };

test('a 401 refreshes the token once and retries once', async () => {
  const fake = await fakeOauth();
  clearToken('oauthprov');
  const provider = {
    type: 'openai',
    baseUrl: `${fake.base}/v1`,
    apiKeyEnv: 'OAUTH_ACCESS', // deliberately unset: the first call has no valid key
    oauth: { tokenUrl: `${fake.base}/token`, clientIdEnv: 'OAUTH_ID', clientSecretEnv: 'OAUTH_SECRET', refreshTokenEnv: 'OAUTH_REFRESH' },
  };

  const adapter = createAdapter('oauthprov', provider, env);
  const result = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.text, 'ok');
  assert.equal(fake.tokenCalls(), 1, 'one refresh, not a loop');
  assert.equal(fake.apiCalls(), 2, 'one failed call and one retry');
  assert.equal(cachedToken('oauthprov'), 'tok-1', 'the token is cached');
  await fake.close();
});

test('a cached token is reused instead of refreshed again', async () => {
  const fake = await fakeOauth();
  clearToken('oauthprov2');
  const provider = {
    type: 'openai',
    baseUrl: `${fake.base}/v1`,
    apiKeyEnv: 'OAUTH_ACCESS',
    oauth: { tokenUrl: `${fake.base}/token`, clientIdEnv: 'OAUTH_ID', clientSecretEnv: 'OAUTH_SECRET', refreshTokenEnv: 'OAUTH_REFRESH' },
  };

  const adapter = createAdapter('oauthprov2', provider, env);
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'one' }] });
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'two' }] });

  assert.equal(fake.tokenCalls(), 1, 'the second call used the cached token');
  await fake.close();
});

test('a provider with no oauth config surfaces the 401 unchanged', async () => {
  const fake = await fakeOauth();
  const provider = { type: 'openai', baseUrl: `${fake.base}/v1`, apiKeyEnv: 'MISSING_KEY' };
  const adapter = createAdapter('plainprov', provider, {});

  await assert.rejects(() => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), (err) => {
    assert.equal(err.status, 401);
    assert.equal(fake.tokenCalls(), 0);
    return true;
  });
  await fake.close();
});

test('a refused refresh reports why, and does not retry the model call', async () => {
  const fake = await fakeOauth({ refreshStatus: 400 });
  clearToken('oauthprov3');
  const provider = {
    type: 'openai',
    baseUrl: `${fake.base}/v1`,
    apiKeyEnv: 'OAUTH_ACCESS',
    oauth: { tokenUrl: `${fake.base}/token`, clientIdEnv: 'OAUTH_ID', clientSecretEnv: 'OAUTH_SECRET', refreshTokenEnv: 'OAUTH_REFRESH' },
  };

  const adapter = createAdapter('oauthprov3', provider, env);
  await assert.rejects(() => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), (err) => {
    assert.equal(err.code, 'refresh_failed');
    return true;
  });
  assert.equal(fake.apiCalls(), 1, 'one attempt, no retry after a failed refresh');
  await fake.close();
});

test('missing refresh credentials name the three variables to set', async () => {
  await assert.rejects(
    () => refreshAccessToken({ providerId: 'x', provider: { oauth: { tokenUrl: 'http://127.0.0.1:1/token', clientIdEnv: 'A', clientSecretEnv: 'B', refreshTokenEnv: 'C' } }, env: {} }),
    (err) => {
      assert.equal(err.code, 'no_refresh_credentials');
      assert.match(err.message, /set A, B and C/);
      return true;
    },
  );
});

test('an expired cached token is discarded, not reused', () => {
  let clock = 1000;
  const now = () => clock;
  // cache a token through the public path
  clearToken('exp');
  const provider = { oauth: { tokenUrl: 'http://127.0.0.1:1/token' } };
  // no fetch here: write through the cache by refreshing against a stub
  return (async () => {
    const fake = await fakeOauth();
    const p = { ...provider, oauth: { ...provider.oauth, tokenUrl: `${fake.base}/token`, clientIdEnv: 'OAUTH_ID', clientSecretEnv: 'OAUTH_SECRET', refreshTokenEnv: 'OAUTH_REFRESH' } };
    await refreshAccessToken({ providerId: 'exp', provider: p, env, now });
    assert.ok(cachedToken('exp', now));
    clock += 3600_000;
    assert.equal(cachedToken('exp', now), null, 'an expired token is dropped');
    await fake.close();
  })();
});
