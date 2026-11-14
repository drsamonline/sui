import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  PRESETS,
  RecallStore,
  atomise,
  caveman,
  ccr,
  choosePreset,
  compress,
  headroom,
  llmLingua2,
  protect,
  restore,
  rtk,
  sessionDedup,
} from '@sui/compression';
import { makeRouter, testConfig, ask } from './helpers.js';

const PROMPT = `You are helping with a Node service. Here is the file:

\`\`\`js
export function handler(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
\`\`\`

The handler is very very very simple and it is basically just a health check that returns ok and nothing else at all really. It does not do anything else. The handler returns ok. The handler is used by the load balancer to check that the service is alive and responding to requests.

See https://example.com/docs/health-checks for the contract, and the config lives at /etc/svc/config.json.

{"timeoutMs": 2000, "path": "/healthz", "expect": {"status": 200}}

The handler is very very very simple and it is basically just a health check that returns ok and nothing else at all really. It does not do anything else.

Please summarise what this handler does and whether it is safe to expose publicly.`;

const PROTECTED = [
  ['fenced code', 'res.writeHead(200'],
  ['url', 'https://example.com/docs/health-checks'],
  ['json', '"timeoutMs": 2000'],
  ['file path', '/etc/svc/config.json'],
];

test('protect and restore round-trip byte-for-byte', () => {
  const { masked, spans } = protect(PROMPT);
  assert.equal(restore(masked, spans), PROMPT);
  assert.ok(spans.length >= 4);
  assert.equal(masked.includes('https://example.com'), false, 'the URL is lifted out');
});

test('every preset keeps code, URLs, JSON and paths intact', () => {
  for (const preset of Object.keys(PRESETS)) {
    const result = compress(PROMPT, { preset, store: new RecallStore({ secret: 'test' }) });
    for (const [label, needle] of PROTECTED) {
      assert.ok(result.text.includes(needle), `${preset} lost the ${label}`);
    }
    assert.ok(result.compressedChars <= result.originalChars);
    assert.ok(result.ratio <= 0.8, `${preset} exceeded the hard cap: ${result.ratio}`);
  }
});

test('a prompt that is mostly protected is left alone, with a reason', () => {
  const code = '```js\n' + 'const x = 1;\n'.repeat(80) + '```\nShort note.';
  const result = compress(code, { preset: 'ultra' });
  assert.ok(result.skipped, 'it should say why it did nothing');
  assert.match(result.skipped, /code, URLs or JSON/);
  assert.equal(result.text, code);
});

test('session_dedup drops a repeated paragraph but never repeated code', () => {
  const prose = 'This paragraph explains the same thing twice in a row, at length, so it can be deduplicated safely.';
  const result = sessionDedup(`${prose}\n\n${prose}`);
  assert.ok(result.droppedChars > 0);
  assert.match(result.text, /repeated context removed/);

  const { masked, spans } = protect('```js\nconst a = 1;\n```\n\n```js\nconst a = 1;\n```');
  const deduped = sessionDedup(masked);
  assert.equal(restore(deduped.text, spans).includes('const a = 1;'), true);
});

test('rtk collapses token and punctuation runs', () => {
  const result = rtk('this is very very very very important!!!');
  assert.match(result.text, /very ×5|very ×4/);
  assert.ok(result.droppedChars > 0);
});

test('caveman strips function words but keeps bracketed code', () => {
  const result = caveman('The handler is basically just a very simple function that returns the value of res.writeHead(200).');
  assert.ok(result.text.length < 90);
  assert.ok(result.text.includes('res.writeHead(200)'));
});

test('headroom keeps the head and the tail and marks the gap', () => {
  const text = `START ${'middle filler text '.repeat(60)}END`;
  const result = headroom(text, { maxChars: 200 });
  assert.ok(result.text.startsWith('START'));
  assert.ok(result.text.trimEnd().endsWith('END'));
  assert.match(result.text, /chars omitted from the middle/);
});

test('headroom never drops a protected span in the middle', () => {
  const { masked, spans } = protect(`START ${'filler '.repeat(200)} {"keep": "me"} ${'filler '.repeat(200)} END`);
  const result = headroom(masked, { maxChars: 120 });
  const restored = restore(result.text, spans);
  assert.ok(restored.includes('{"keep": "me"}'), 'the JSON in the middle must survive');
});

test('atomise treats a placeholder as one indivisible atom', () => {
  const atoms = atomise('a\u00000\u0000b');
  assert.deepEqual(atoms, ['a', '\u00000\u0000', 'b']);
});

test('llmlingua keeps the rarest sentences and the last one', () => {
  const text =
    'The the the the is a a a of of of. Something specific about idempotency keys and retry budgets matters here. Another generic sentence about the thing and the stuff. Final question: is it safe?';
  const result = llmLingua2(text, { keep: 0.5 });
  assert.ok(result.text.includes('idempotency'), 'the sentence with rare terms survives');
  assert.ok(result.text.includes('Final question'), 'the last sentence survives');
});

test('ccr hides text behind a signed token that can be retrieved, and rejects a tampered one', () => {
  const store = new RecallStore({ secret: 'unit-test' });
  // the marker sits well inside the dropped half, so the assertion is about the
  // store and not about where the head/dropped boundary happens to land
  const text = `${'a'.repeat(300)}${' '.repeat(40)}RECALL-MARKER${'b'.repeat(260)}`;
  const result = ccr(text, { store, keepShare: 0.5 });
  assert.ok(result.token);
  assert.match(result.text, /sui:recall/);
  assert.equal(store.get(result.token).includes('RECALL-MARKER'), true, 'the dropped text is retrievable');
  assert.equal(store.get('deadbeef.00000000'), null, 'a forged token retrieves nothing');
  assert.equal(store.verify(result.token), true);
});

test('aggressive saves more than lite on prose-heavy input', () => {
  const prose = 'The handler is basically just a very simple function that returns ok and nothing else at all really. '.repeat(8);
  const lite = compress(prose, { preset: 'lite' });
  const aggressive = compress(prose, { preset: 'aggressive' });
  assert.ok(aggressive.ratio > lite.ratio, `aggressive ${aggressive.ratio} should beat lite ${lite.ratio}`);
});

test('the budget manager maps remaining quota to a preset', () => {
  assert.equal(choosePreset({ fraction: 1 }).preset, 'lite');
  assert.equal(choosePreset({ fraction: 0.5 }).preset, 'standard');
  assert.equal(choosePreset({ fraction: 0.2 }).preset, 'aggressive');
  assert.equal(choosePreset({ fraction: 0.05 }).preset, 'ultra');
  assert.equal(choosePreset({ remaining: 30, limit: 100 }).preset, 'aggressive');
  assert.match(choosePreset({ fraction: 0.05 }).reason, /last turns/);
});

test('an unknown preset is refused with the list', () => {
  assert.throws(() => compress('x'.repeat(500), { preset: 'nope' }), /Unknown compression preset/);
});

/* ------------------------------------------------- router integration */

async function capturingUpstream() {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('compression is off by default: the provider receives the prompt unchanged', async () => {
  const upstream = await capturingUpstream();
  const { router } = makeRouter(testConfig({ fakeUrl: upstream.url }));
  const res = await router.chat({ combo: 'chain', body: ask(PROMPT) });
  assert.equal(res.meta.compression, null);
  assert.equal(upstream.bodies[0].messages[0].content, PROMPT);
  await upstream.close();
});

test('with compression on, the older context shrinks and the question survives', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  // prefix protection is off here so the system message is fair game; the next
  // test covers what happens when it is on (the default).
  config.compression = { enabled: true, preset: 'aggressive', minChars: 100, preserveCachedPrefix: false };
  const { router } = makeRouter(config);

  const messages = [
    { role: 'system', content: PROMPT },
    { role: 'user', content: 'and what about the timeout?' },
  ];
  const res = await router.chat({ combo: 'chain', body: { messages, max_tokens: 32 } });

  const sent = upstream.bodies[0].messages;
  assert.ok(sent[0].content.length < PROMPT.length, 'the system message should be smaller');
  assert.equal(sent[1].content, 'and what about the timeout?', 'the question is untouched');
  assert.equal(res.meta.compression.preset, 'aggressive');
  assert.ok(res.meta.compression.savedChars > 0);
  assert.ok(res.meta.compression.steps.length > 0);
  assert.ok(res.meta.compression.ratio > 0);
  await upstream.close();
});

test('B4.5: the cacheable prefix is left untouched so the provider cache still hits', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  config.compression = { enabled: true, preset: 'ultra', minChars: 100 }; // preserveCachedPrefix defaults to true
  const { router } = makeRouter(config);

  const messages = [
    { role: 'system', content: PROMPT },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'a long answer that repeats itself. '.repeat(20) },
    { role: 'user', content: 'and now the real question' },
  ];
  const res = await router.chat({ combo: 'chain', body: { messages, max_tokens: 32 } });

  const sent = upstream.bodies[0].messages;
  assert.equal(sent[0].content, PROMPT, 'the system message is byte-for-byte what it was');
  assert.equal(sent[3].content, 'and now the real question', 'the question is untouched');
  assert.ok(sent[2].content.length < messages[2].content.length, 'the middle turn was compressed');
  assert.equal(res.meta.compression.prefixProtected, true);
  await upstream.close();
});

test('B4.5: with prefix protection on and nothing else to compress, it says why', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  config.compression = { enabled: true, preset: 'aggressive', minChars: 100 };
  const { router } = makeRouter(config);

  const res = await router.chat({
    combo: 'chain',
    body: { messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: 'hi' }], max_tokens: 32 },
  });
  assert.equal(res.meta.compression.savedChars, 0);
  assert.match(res.meta.compression.skipped, /cacheable prefix was left untouched/);
  await upstream.close();
});

test('auto mode picks a harder preset as the provider budget runs out', async () => {
  const upstream = await capturingUpstream();
  const config = testConfig({ fakeUrl: upstream.url });
  config.compression = { enabled: true, preset: 'auto', minChars: 100 };
  config.budgets = { dailyUsd: null, warnAtPct: 80, perProvider: { fake: 0.001 } };
  const { router, ledger } = makeRouter(config);

  // spend most of the provider's cap
  ledger.record({ provider: 'fake', modelId: 'fake-a', costUsd: 0.00095, ts: Date.now() });

  const res = await router.chat({
    combo: 'chain',
    body: { messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: 'go on' }], max_tokens: 32 },
  });
  assert.equal(res.meta.compression.preset, 'ultra', '5% of the cap left should squeeze hardest');
  assert.match(res.meta.compression.reason, /quota left/);
  await upstream.close();
});

/* -------------------------------------------------- B10.4 the compression view */

test('POST /api/compress reports the ratio, the steps and the protected spans', async () => {
  const { makeGateway } = await import('./helpers.js');
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const prompt = `The handler is basically just a very simple health check that returns ok and nothing else at all really. It does not do anything else.\n\n\`\`\`js\nres.writeHead(200);\n\`\`\`\n\nSee https://example.com/docs for the contract.`;
  const res = await fetch(`http://127.0.0.1:${port}/api/compress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: prompt, preset: 'aggressive' }),
  });
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.preset, 'aggressive');
  assert.ok(json.ratio > 0);
  assert.ok(json.steps.length > 0);
  assert.equal(json.text.includes('res.writeHead(200)'), true, 'the code block survives');
  assert.equal(json.text.includes('https://example.com/docs'), true, 'the URL survives');
  assert.match(json.note, /Nothing was stored, logged or sent/);
  await gw.close();
});

test('POST /api/compress refuses an unknown preset and empty text', async () => {
  const { makeGateway } = await import('./helpers.js');
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const bad = await fetch(`http://127.0.0.1:${port}/api/compress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello there', preset: 'turbo' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.type, 'bad_preset');

  const empty = await fetch(`http://127.0.0.1:${port}/api/compress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(empty.status, 400);
  await gw.close();
});

/* ------------------------------------------- B4.2 canonicalise */

test('canonicalise is lossless in meaning and strict about form', async () => {
  const { canonicalise } = await import('@sui/compression');
  const messy = 'The \u2018handler\u2019 returns ok\u2014nothing else.\u200b\r\n\r\n\r\n\r\n    const x = 1;\r\n    const y = 2;\r\n\r\n\r\nSee \u201chttps://example.com\u201d.   \n\n\n\nEnd.';
  const result = canonicalise(messy);

  assert.ok(result.droppedChars > 0);
  assert.match(result.text, /The 'handler' returns ok-nothing else\./, 'smart quotes and the em dash are normalised');
  assert.equal(result.text.includes('\u200b'), false, 'zero-width characters are removed');
  assert.equal(result.text.includes('\r'), false, 'line endings are unified');
  assert.equal(/ {2,}$/m.test(result.text), false, 'trailing spaces are gone');
  assert.equal(result.text.includes('\n\n\n'), false, 'runs of blank lines collapse');
  // dedent removes the indentation *every* line shares; here the prose starts at
  // column 0, so the code keeps its four spaces — that is correct, not a miss
  assert.match(result.text, /^    const x = 1;$/m, 'mixed indentation is preserved as written');

  const indented = '    const a = 1;\n    const b = 2;\n    return a + b;';
  const dedented = canonicalise(indented).text;
  assert.match(dedented, /^const a = 1;$/m, 'a uniformly indented block is dedented');
});

test('every preset starts with canonicalise, so nothing is compressed before it is tidy', async () => {
  const { PRESETS } = await import('@sui/compression');
  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.equal(preset.engines[0], 'canonicalise', `${name} must canonicalise first`);
  }
});

test('canonicalise does not damage protected spans', () => {
  const code = '```js\nconst a = 1;\n```';
  const result = compress(`${'prose '.repeat(60)}\n\n${code}`, { preset: 'lite' });
  assert.ok(result.text.includes('const a = 1;'), 'the code block is untouched');
});
