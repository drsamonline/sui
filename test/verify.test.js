import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULT_THRESHOLD, scoreAnswer, shouldEscalate, verdict } from '@sui/verify';
import { explainPlan, explainTurn } from '@sui/router';
import { makeRouter, makeGateway, testConfig, ask } from './helpers.js';

const PROMPT = 'What does a circuit breaker do in a gateway?';
const GOOD = 'A circuit breaker stops sending requests to a provider after repeated failures, then allows one trial request after a cooldown to see whether it has recovered.';

/* ------------------------------------------------------- scoring */

test('a direct, on-topic answer scores full confidence', () => {
  const score = scoreAnswer({ text: GOOD, prompt: PROMPT, finishReason: 'stop' });
  assert.equal(score.confidence, 1);
  assert.deepEqual(score.reasons, []);
  assert.equal(verdict(score).verified, true);
});

test('hedging, truncation and a refusal each cost confidence, with a named reason', () => {
  const hedged = scoreAnswer({ text: 'I think maybe a circuit breaker is probably something about retries, not sure.', prompt: PROMPT });
  assert.ok(hedged.confidence < DEFAULT_THRESHOLD);
  assert.ok(hedged.reasons.some((r) => r.signal === 'hedging'));

  const cut = scoreAnswer({ text: GOOD, prompt: PROMPT, finishReason: 'length' });
  assert.ok(cut.reasons.some((r) => r.signal === 'truncated'));

  const refused = scoreAnswer({ text: 'I cannot help with that request about circuit breakers.', prompt: PROMPT });
  assert.ok(refused.reasons.some((r) => r.signal === 'refusal'));
});

test('an empty answer is a failure, not a short one', () => {
  const score = scoreAnswer({ text: '   ', prompt: PROMPT });
  assert.equal(score.confidence, 0);
  assert.equal(score.reasons[0].signal, 'empty');
});

test('JSON requested and prose returned is a shape failure', () => {
  const score = scoreAnswer({ text: 'Sure! Here is the circuit breaker explanation you asked for.', prompt: PROMPT, wantsJson: true });
  assert.ok(score.reasons.some((r) => r.signal === 'wrong_shape'));
});

test('an answer that shares nothing with the question is flagged as off topic', () => {
  const score = scoreAnswer({ text: 'Bananas ripen faster in a paper bag with ethylene gas nearby.', prompt: PROMPT });
  assert.ok(score.reasons.some((r) => r.signal === 'off_topic'));
});

test('the verdict is fail-closed and explains itself', () => {
  const weak = scoreAnswer({ text: 'I think maybe not sure about circuit breakers.', prompt: PROMPT });
  const v = verdict(weak);
  assert.equal(v.verified, false);
  assert.equal(v.ok, false);
  assert.match(v.summary, /below the 0\.7 threshold/);
  assert.ok(v.summary.length > 40, 'the summary names the reasons');
});

test('escalation stops when there is nothing left to escalate to', () => {
  assert.equal(shouldEscalate({ confidence: 0.2, escalationsLeft: 1 }), true);
  assert.equal(shouldEscalate({ confidence: 0.2, escalationsLeft: 0 }), false);
  assert.equal(shouldEscalate({ confidence: 0.9, escalationsLeft: 1 }), false);
});

/* ------------------------------------------------------- router behaviour */

/** A fake upstream that answers weakly for one model and well for another. */
async function tieredUpstream() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    const weak = String(body.model ?? '').includes('weak');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content: weak ? 'I think maybe it is probably something about retries, not sure.' : GOOD },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function tieredConfig(url, verification = {}) {
  const config = testConfig();
  config.providers.fake = { type: 'openai', baseUrl: url, apiKeyEnv: null, timeoutMs: 3000 };
  config.models['weak-1'] = { provider: 'fake', model: 'weak-model', costPer1kIn: 0.1, costPer1kOut: 0.1, quality: 3 };
  config.models['strong-1'] = { provider: 'fake', model: 'strong-model', costPer1kIn: 1, costPer1kOut: 1, quality: 5 };
  config.combos.tiered = { strategy: 'fallback', targets: ['weak-1', 'strong-1'] };
  config.combos.weakonly = { strategy: 'fallback', targets: ['weak-1'] };
  config.verification = { enabled: true, threshold: 0.7, maxEscalations: 1, ...verification };
  return config;
}

test('verification is off by default: no score, no escalation', async () => {
  const upstream = await tieredUpstream();
  const config = tieredConfig(upstream.url);
  delete config.verification;
  const { router } = makeRouter(config);

  const res = await router.chat({ combo: 'tiered', body: ask(PROMPT) });
  assert.equal(res.meta.verification, null);
  assert.equal(res.meta.modelId, 'weak-1', 'no escalation without verification');
  await upstream.close();
});

test('a low-confidence answer escalates to the next target, and the better answer wins', async () => {
  const upstream = await tieredUpstream();
  const { router } = makeRouter(tieredConfig(upstream.url));

  const res = await router.chat({ combo: 'tiered', body: ask(PROMPT) });
  assert.equal(res.meta.modelId, 'strong-1', 'the stronger target answered');
  assert.equal(res.meta.verification.verified, true, 'and it cleared the bar');
  assert.ok(
    res.meta.attempts.some((a) => /below 0\.7 — escalating/.test(a.reason)),
    'the escalation is on the record',
  );
  await upstream.close();
});

test('when nothing clears the bar, the best answer comes back marked unverified', async () => {
  const upstream = await tieredUpstream();
  const { router } = makeRouter(tieredConfig(upstream.url));

  const res = await router.chat({ combo: 'weakonly', body: ask(PROMPT) });
  assert.match(res.text, /not sure/, 'the answer is returned, not thrown away');
  assert.equal(res.meta.verified, false);
  assert.equal(res.meta.verification.verified, false);
  assert.match(res.meta.escalation, /never reached 0\.7/);
  await upstream.close();
});

/* ------------------------------------------------------- explain-my-route */

test('explainPlan narrates the decision in sentences', () => {
  const config = testConfig();
  config.combos.chain.targets = ['fake-a', 'unkeyed', 'mock-a'];
  const { router } = makeRouter(config);
  const lines = explainPlan(router.plan('chain', {}));
  const text = lines.join(' ');

  assert.match(text, /"chain" is a fallback route with 3 targets/);
  assert.match(text, /It would try fake-a → mock-a/);
  assert.match(text, /Skipped unkeyed: no API key set/);
});

test('explainTurn narrates a completed turn', () => {
  const lines = explainTurn({
    modelId: 'gemini-flash',
    providerName: 'Gemini',
    provider: 'gemini',
    latencyMs: 812,
    cached: false,
    attempts: [{ modelId: 'groq-70b', provider: 'groq', reason: 'rate-limited' }],
    verification: { confidence: 0.55, threshold: 0.7, verified: false, reasons: [{ detail: 'hedging' }] },
  });
  const text = lines.join(' ');
  assert.match(text, /Answered by gemini-flash \(Gemini\) in 812 ms/);
  assert.match(text, /groq-70b did not answer: rate-limited/);
  assert.match(text, /Confidence 0\.55 is below 0\.7/);
});

test('/api/explain answers without sending a request', async () => {
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const json = await (await fetch(`http://127.0.0.1:${port}/api/explain?combo=chain`)).json();
  assert.equal(json.combo, 'chain');
  assert.ok(json.lines.length >= 2);
  assert.deepEqual(json.plan.ordered, ['fake-a', 'mock-a'], 'both reachable targets, in declared order');
  assert.ok(Array.isArray(json.plan.skipped), 'skips are reported as a list, even when empty');
  assert.equal(gw.ledger.records.length, 0, 'nothing was sent');

  const missing = await fetch(`http://127.0.0.1:${port}/api/explain?combo=nope`);
  assert.equal(missing.status, 404);
  await gw.close();
});

/* ------------------------------------------------------- B7.6 grounding */

test('an answer whose claims are in the context is grounded', async () => {
  const { checkGrounding } = await import('@sui/verify');
  const context = 'Groq answered in 812 ms. Docs: https://example.com/docs/health-checks. Released 2024.';
  const result = checkGrounding({
    answer: 'It answered in 812 ms, per https://example.com/docs/health-checks, released 2024.',
    context,
  });
  assert.equal(result.checked, true);
  assert.equal(result.supported, true);
  assert.deepEqual(result.findings, []);
});

test('a fabricated URL, quote and number are each caught', async () => {
  const { checkGrounding } = await import('@sui/verify');
  const context = 'The service returns 200 on the health endpoint. Docs: https://example.com/docs.';
  const result = checkGrounding({
    answer: 'It says "the gateway never fails over" and returns 200 at https://evil.example/x for $1.2m.',
    context,
  });
  assert.equal(result.supported, false);
  const kinds = result.findings.map((f) => f.kind);
  assert.ok(kinds.includes('url'));
  assert.ok(kinds.includes('quote'));
  assert.ok(kinds.includes('number'));
});

test('with no context there is nothing to ground against, and it says so', async () => {
  const { checkGrounding } = await import('@sui/verify');
  const result = checkGrounding({ answer: 'Anything at all, 42%.', context: '' });
  assert.equal(result.checked, false);
  assert.equal(result.supported, true, 'an unchecked answer is not a failed one');
});

test('an ungrounded answer loses confidence and is not called verified', async () => {
  const upstream = await tieredUpstream();
  const config = tieredConfig(upstream.url);
  config.verification = { enabled: true, threshold: 0.7, maxEscalations: 0, grounding: 'block' };
  const { router } = makeRouter(config);

  const res = await router.chat({
    combo: 'weakonly',
    body: {
      messages: [
        { role: 'system', content: 'The docs live at https://example.com/docs and the timeout is 2000 ms.' },
        { role: 'user', content: 'what is the timeout?' },
      ],
    },
  });

  // the weak fake answers with a hedge, and its numbers are not in the context
  assert.equal(res.meta.verification.grounding.checked, true);
  assert.equal(res.meta.verified, false);
  assert.ok(res.meta.verification.reasons.some((r) => r.signal === 'ungrounded' || r.signal === 'hedging'));
  await upstream.close();
});

test('grounding off means no check and no finding', async () => {
  const upstream = await tieredUpstream();
  const config = tieredConfig(upstream.url);
  config.verification = { enabled: true, threshold: 0.7, maxEscalations: 0 };
  const { router } = makeRouter(config);

  const res = await router.chat({
    combo: 'tiered',
    body: { messages: [{ role: 'system', content: 'context here' }, { role: 'user', content: 'what does a circuit breaker do' }] },
  });
  assert.equal(res.meta.verification.grounding, null);
  await upstream.close();
});
