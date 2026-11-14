# Connect a coding tool

**Goal:** your editor talks to Sui instead of a provider, and you can see which provider answered.

## What Sui offers

An OpenAI-compatible endpoint at `http://127.0.0.1:8787/v1`. Anything that lets you set a base URL and an API key works.

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sui-local   # any non-empty string unless apiKeys are configured
```

## One-click where a file exists

```bash
node apps/cli/bin/sui.js tools                 # what is installed on this machine
node apps/cli/bin/sui.js tools --set continue  # writes ~/.continue/config.json
node apps/cli/bin/sui.js tools --set aider     # writes ~/.aider.conf.yml
node apps/cli/bin/sui.js tools --set zed       # writes ~/.config/zed/settings.json
```

It merges rather than replaces, and it says which file it touched.

## Paste two fields where it doesn't

Cursor, Cline and Roo Code keep settings inside the app, so Sui prints what to paste instead of editing their internal state:

| Tool | Where | What |
|---|---|---|
| Cursor | Settings → Models | OpenAI API key = `sui-local`, Override base URL = `http://127.0.0.1:8787/v1` |
| Cline / Roo | API Provider | `OpenAI Compatible`, Base URL as above, Model ID = a combo name |
| Codex CLI | `~/.codex/config.toml` | `base_url` under the model provider |

## Which model name to use

A **combo** is a virtual model: `chat-default`, `coding`, `cheap`. Use one of those and the router picks the provider. Some tools insist on a name from a provider catalogue — for those, use a bare model id (`groq-70b`), which routes to exactly that model.

```bash
node apps/cli/bin/sui.js models   # combos, strategies, and what each can reach
```

## Check it worked

Send a message in the tool, then:

```bash
node apps/cli/bin/sui.js cost --json | jq '.byProvider'
```

If the provider you expected is there, the tool is going through Sui. If nothing appears, the tool is still talking to its own endpoint.
