/**
 * Node 20+ — no dependencies. Run: node docs/quickstarts/node.mjs
 */
const SUI = process.env.SUI ?? 'http://127.0.0.1:8787';

const res = await fetch(`${SUI}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'chat-default',
    messages: [{ role: 'user', content: 'Explain a circuit breaker in one sentence.' }],
  }),
});

if (!res.ok) {
  const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  console.error(err.error.message); // already a sentence, with a next step
  process.exit(1);
}

const json = await res.json();
console.log(json.choices[0].message.content);
console.log('—', json.sui.provider, json.sui.modelId, `${json.sui.latencyMs}ms`, `$${json.sui.costUsd}`);

// Streaming: first token is the loading state.
const stream = await fetch(`${SUI}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'chat-default', stream: true, messages: [{ role: 'user', content: 'Count to three.' }] }),
});

const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let i;
  while ((i = buffer.indexOf('\n\n')) !== -1) {
    const block = buffer.slice(0, i);
    buffer = buffer.slice(i + 2);
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const payload = JSON.parse(data);
      process.stdout.write(payload.choices?.[0]?.delta?.content ?? '');
    }
  }
}
console.log();
