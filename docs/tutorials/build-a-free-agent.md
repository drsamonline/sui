# Build a free agent

**Goal:** a small script that asks three different routes the same question and survives one of them failing.

## The shape

A combo is the whole trick. Declare several free targets and let the router deal with the one that is resting:

```json
"combos": {
  "free-panel": { "strategy": "fallback", "targets": ["groq-fast", "or-free", "local-qwen"] }
}
```

## The script

```js
// agent.mjs — node agent.mjs "what does a circuit breaker do?"
const SUI = process.env.SUI ?? 'http://127.0.0.1:8787';

async function ask(combo, question) {
  const res = await fetch(`${SUI}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: combo, messages: [{ role: 'user', content: question }], max_tokens: 400 }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return { text: json.choices[0].message.content, who: json.sui.provider, verified: json.sui.verified, usd: json.sui.costUsd };
}

const question = process.argv[2] ?? 'what does a circuit breaker do?';
const answers = [];
for (const combo of ['free-panel', 'cheap']) {
  try {
    answers.push({ combo, ...(await ask(combo, question)) });
  } catch (err) {
    answers.push({ combo, error: err.message });
  }
}

for (const a of answers) {
  console.log(a.error ? `✗ ${a.combo}: ${a.error}` : `✓ ${a.combo} via ${a.who} ($${a.usd})`);
}
```

Run it with one provider key deliberately broken. The first combo should still answer, from the next target, and the response's `sui.attempts` will name what failed.

## Keep it honest

- **`verified` is not "correct".** It means a real upstream answered (and, with verification on, that the answer cleared the confidence bar).
- **Check the cost.** `sui savings` shows what cache and compression avoided; a free tier is not free if you burn it on repeated prompts.
- **Bound the run.** `max_tokens`, a wall-clock timeout, and a step limit are cheaper than an agent that loops.

## Next

- Make it a tool-using agent: that is Phase 5 (MCP), not built yet — `ROADMAP.md` says so plainly.
- Harden it against untrusted input: [red-team-your-own-routes](red-team-your-own-routes.md).
