#!/usr/bin/env bash
# cURL — the shortest possible request, then the provenance block.
set -euo pipefail

SUI=${SUI:-http://127.0.0.1:8787}

curl -s "$SUI/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{
    "model": "chat-default",
    "messages": [{ "role": "user", "content": "Summarise what a circuit breaker does in one sentence." }]
  }' | jq '{answer: .choices[0].message.content, who: .sui.provider, verified: .sui.verified, cached: .sui.cached, ms: .sui.latencyMs, usd: .sui.costUsd}'

# Streaming: the first token arrives as it is produced.
curl -sN "$SUI/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"chat-default","stream":true,"messages":[{"role":"user","content":"Count to three."}]}' \
  | grep '^data:' | sed 's/^data: //' | grep -v '^\[DONE\]$' \
  | jq -r '.choices[0].delta.content // empty' | tr -d '\n'
echo
