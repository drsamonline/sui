# Migrating from another router

```bash
npx sui migrate ./old-router.json            # preview only, writes nothing
npx sui migrate ./old-router.json --apply    # import, then smoke-test
npx sui migrate ./old-router.json --apply --only groq,llama,chat
```

## What the importer does

It reads the old config, finds the concepts every router has, and maps them:

| Concept | Names it looks for | Becomes |
|---|---|---|
| Providers | `providers`, `connections`, `upstreams`, `channels`, `endpoints` | `providers` |
| Base URL | `baseUrl`, `base_url`, `api_base`, `apiBase`, `url` | `baseUrl` |
| Key reference | `apiKeyEnv`, `api_key_env` | `apiKeyEnv` |
| Key literal | `apiKey`, `api_key`, `key` | **`apiKeyEnv` + a warning** — the literal never enters your new config |
| Type | `type`, `kind`, `format`, or inferred from the URL | `openai` / `anthropic` / `gemini` / `mock` |
| Models | `models`, `modelMap`, `model_map` | `models` |
| Upstream name | `model`, `upstreamModel`, `upstream_model`, `name` | `model` |
| Prices | `costPer1kIn` / `costPer1kOut`, `inputCost` / `outputCost` | `costPer1kIn` / `costPer1kOut` |
| Virtual models | `combos`, `aliases`, `routes`, `virtualModels`, `virtual_models`, `groups`, `profiles` | `combos` |
| Strategy | `strategy`, `mode`, `type` (`ab-split` → `weighted`, `cheapest` → `cheapest`) | `strategy` |

Three things it will not do:

- **It will not import a secret.** A literal key becomes an env var name plus a line telling you which one to fill in.
- **It will not drop what it does not understand.** Unrecognised top-level keys are listed by name in the preview.
- **It will not write anything before you have seen the diff.** `--apply` is a separate decision.

YAML configs are refused with a way forward, not a stack trace: most routers have an "export config" that writes JSON.

## The preview

```
Reading ./9router.json — looks like 9router

Found  3 providers · 3 models · 2 combos

New to your config
  providers  groq, claude, local
  models     llama, sonnet, qwen
  combos     chat, split

Skipped (already exist here)
  combo chat — already exists in your config

Models whose provider is not coming along: —
Combos pointing at models that are not coming along: —

Notes
  - Provider "groq" had its key written into the old config. I set apiKeyEnv instead — put the key in .env as GROQ_API_KEY.

Keys I did not recognise (left untouched): telemetry
```

## After the import

`--apply` writes the merge, keeps the previous file as `sui.config.json.bak-<timestamp>`, then runs a **smoke test**: one small real turn per imported combo, reported per combo.

```
Smoke test — one small turn per imported combo
  combo  result      provider  note
  chat   ok          groq      412 ms
  split  unverified  mock      answered by a mock/local provider, so the upstream was not exercised
```

Read those statuses literally:

- `ok` — a real upstream answered. The route works.
- `unverified` — something answered, but not a real provider (a mock or an unverified local endpoint). The import may be fine; the upstream was not exercised.
- `failed` — the note is the reason. Fix it before pointing anything at the gateway.

## Checklist

1. `npx sui migrate ./old.json` — read the preview. Check the "not recognised" line.
2. Fill in the env vars the notes named, in `.env`.
3. `npx sui migrate ./old.json --apply` — read the smoke test.
4. `npx sui doctor` — every combo, one real turn each.
5. Point one tool at `http://127.0.0.1:8787/v1` and use it for a day before moving the rest.
6. `npx sui cost` — confirm the numbers look like your old bill, or better.

Keep the old router running until step 5 is comfortable. Both can coexist on different ports; nothing in sui assumes it is the only gateway.
