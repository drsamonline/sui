import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeRouter, testConfig, ask } from './helpers.js';

/**
 * An upstream that answers 200 with nothing in it — which is what several free
 * tiers do when they are throttling. `empties` controls how many turns come back
 * blank before real text appears.
 */
async function startEmptyThenReal(empties = 1) {
  let turns = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    turns += 1;
    const blank = turns <= empties;

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
      if (!blank) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'real answer' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: blank ? '' : 'real answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 6, completion_tokens: blank ? 0 : 3 },
      }),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get turns() {
      return turns;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('an empty turn is retried once on the same target, and the retry answers', async () => {
  const upstream = await startEmptyThenReal(1);
  const { router, ledger } = makeRouter(testConfig({ fakeUrl: upstream.url }));

  const res = await router.chat({ combo: 'chain', body: ask('hello') });
  assert.equal(res.text, 'real answer');
  assert.equal(upstream.turns, 2, 'one empty turn, one retry');
  assert.match(res.meta.attempts[0].reason, /empty turn/);

  const errors = ledger.records.filter((r) => r.error === 'empty_turn');
  assert.equal(errors.length, 1, 'the empty turn is on the record');
  assert.equal(ledger.records.filter((r) => r.ok).length, 1);
  await upstream.close();
});

test('still empty after the retry: the next target answers, and nothing blank reaches the user', async () => {
  const upstream = await startEmptyThenReal(99);
  const { router, ledger } = makeRouter(testConfig({ fakeUrl: upstream.url }));

  const res = await router.chat({ combo: 'chain', body: ask('hello') });
  assert.equal(res.meta.modelId, 'mock-a', 'it should have fallen through to the mock');
  assert.match(res.text, /Mock reply/);
  assert.equal(upstream.turns, 2, 'exactly one retry, not a loop');
  assert.equal(ledger.records.filter((r) => r.error === 'empty_turn').length, 2);
  await upstream.close();
});

test('with the retry switched off, an empty turn goes straight to the next target', async () => {
  const upstream = await startEmptyThenReal(99);
  const config = testConfig({ fakeUrl: upstream.url });
  config.streaming = { emptyTurnRetry: false };
  const { router } = makeRouter(config);

  const res = await router.chat({ combo: 'chain', body: ask('hello') });
  assert.equal(res.meta.modelId, 'mock-a');
  assert.equal(upstream.turns, 1, 'no retry should have been attempted');
  await upstream.close();
});

test('a stream that sends a role frame but no content counts as an empty turn', async () => {
  const upstream = await startEmptyThenReal(1);
  const { router } = makeRouter(testConfig({ fakeUrl: upstream.url }));

  const chunks = [];
  const res = await router.chat({
    combo: 'chain',
    body: { ...ask('stream please'), stream: true },
    onToken: (t) => chunks.push(t),
  });
  assert.equal(res.text, 'real answer');
  assert.equal(chunks.join(''), 'real answer', 'the client only sees the real answer');
  await upstream.close();
});

test('an empty turn does not trip the breaker: it is a quality problem, not an outage', async () => {
  const upstream = await startEmptyThenReal(99);
  const { router, breaker } = makeRouter(testConfig({ fakeUrl: upstream.url }));
  for (let i = 0; i < 4; i++) await router.chat({ combo: 'chain', body: ask(`turn ${i}`) });
  assert.equal(breaker.stateOf('fake-a').state, 'closed', 'I13 still holds: no 5xx, no trip');
  await upstream.close();
});
