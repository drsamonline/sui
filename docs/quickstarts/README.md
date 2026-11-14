# Quickstarts

Copy-paste snippets for the gateway. All of them assume `sui start` is running on `http://127.0.0.1:8787`.

| Language | File | Notes |
|---|---|---|
| cURL | [`curl.sh`](curl.sh) | nothing to install |
| Node 20+ | [`node.mjs`](node.mjs) | `fetch` is built in, no dependencies |
| Python 3.9+ | [`python.py`](python.py) | `urllib` only, no `pip install` |
| PHP 8+ | [`php.php`](php.php) | cURL extension |

Every response carries a `sui` block — provider, model, whether it was verified, whether it came from cache, latency, cost, and what failed on the way. Print it once and you will never wonder who answered again.

If you use a vendor SDK instead of raw HTTP, point it at the gateway and it just works:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sui-local     # any non-empty string unless apiKeys are configured
```

`model` may be a combo (`chat-default`) or a bare model id (`groq-70b`), because some tools refuse names they cannot find in a provider catalogue.
