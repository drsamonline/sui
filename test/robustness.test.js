import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { makeGateway, testConfig } from './helpers.js';

/**
 * What the gateway does with input nobody meant to send.
 *
 * Every case here is something a real client does by accident — a truncated body,
 * a proxy that drops the content type, a prompt with an emoji, twenty requests at
 * once — and the contract is the same for all of them: an answer, never a crash,
 * never a stack trace, never a hang.
 */

async function withGateway(fn) {
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  try {
    return await fn(port, gw);
  } finally {
    await gw.close();
  }
}

function send(port, { method = 'POST', path = '/v1/chat/completions', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* an HTML or empty body is allowed to be unparseable here */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('the gateway did not answer in 15s')));
    if (payload) req.write(payload);
    req.end();
  });
}

const chat = (extra = {}) => ({ model: 'chain', messages: [{ role: 'user', content: 'hi' }], ...extra });

test('truncated JSON is a 400 with a sentence, not a crash', async () => {
  await withGateway(async (port) => {
    const res = await send(port, { body: '{"model":"chain","messages":[{' });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /valid JSON/);
  });
});

test('an empty body is a 400, and says what is missing', async () => {
  await withGateway(async (port) => {
    const res = await send(port, { body: '' });
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.ok(res.json?.error?.message, 'a refusal must carry a message');
  });
});

test('an unknown model is a 404 that lists what exists', async () => {
  await withGateway(async (port) => {
    const res = await send(port, { body: chat({ model: 'gpt-9-imaginary' }) });
    assert.equal(res.status, 404);
    assert.match(res.json.error.message, /not a combo or model this gateway knows/);
    assert.match(res.json.error.message, /chain/, 'the message names what is available');
  });
});

test('a body larger than the limit is refused with 413, not buffered forever', async () => {
  await withGateway(async (port) => {
    const huge = JSON.stringify(chat({ messages: [{ role: 'user', content: 'x'.repeat(21_000_000) }] }));
    const res = await send(port, { body: huge });
    assert.equal(res.status, 413);
    assert.match(res.json.error.message, /20 MB/);
  });
});

test('a prompt in another script is answered, not mangled', async () => {
  await withGateway(async (port) => {
    const res = await send(port, {
      body: chat({ messages: [{ role: 'user', content: 'नमस्ते — ગુજરાતી, தமிழ், 🎯' }] }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.choices?.[0]?.message?.content, 'an answer came back');
  });
});

test('a caller-supplied header is never reflected back into a response header', async () => {
  await withGateway(async (port) => {
    // A CRLF cannot be sent at all — Node's client refuses it, which is the first
    // line of defence. What a hostile client *can* send is markup and quotes, so
    // the test is that none of it comes back in a header.
    const nasty = '"><script>alert(1)</script>; DROP TABLE keys;';
    const res = await send(port, { headers: { 'x-sui-user': nasty, 'x-sui-tool': 'a'.repeat(4096) } });

    assert.ok(res.status < 500 || res.status === 503, `unexpected status ${res.status}`);
    for (const [name, value] of Object.entries(res.headers)) {
      assert.equal(String(value).includes('<script>'), false, `header ${name} echoed the caller's value`);
    }
    // and if it appears in the body at all, it is JSON, not markup
    assert.equal(res.body.includes('<script>alert(1)</script>; DROP'), false);
  });
});

test('twenty requests at once all get an answer', async () => {
  await withGateway(async (port) => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => send(port, { body: chat({ messages: [{ role: 'user', content: `hi ${i}` }] }) })));
    for (const res of results) {
      assert.ok(res.status === 200 || res.status === 503, `a concurrent request got ${res.status}`);
    }
    const served = results.filter((r) => r.status === 200).length;
    assert.ok(served >= 15, `only ${served} of 20 were served`);
  });
});

test('a method the gateway does not serve is a 404, not a hang', async () => {
  await withGateway(async (port) => {
    const res = await send(port, { method: 'DELETE', path: '/v1/chat/completions', body: null });
    assert.equal(res.status, 404);
  });
});

test('an unknown path is a 404 with a message', async () => {
  await withGateway(async (port) => {
    const res = await send(port, { method: 'GET', path: '/nope', body: null });
    assert.equal(res.status, 404);
    assert.match(res.json.error.message, /No route for GET \/nope/);
  });
});

test('a malformed Host header is refused by the allowlist', async () => {
  await withGateway(async (port) => {
    const res = await send(port, { headers: { host: 'evil.example' }, body: chat() });
    assert.equal(res.status, 403);
    assert.match(res.json.error.message, /does not answer to the host/);
  });
});
