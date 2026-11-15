# Recipes

A recipe is a named config patch. The point is that a working setup should not require reading a schema.

```bash
sui recipe list                       # what is available
sui recipe show free-tier-stack       # the patch, in full
sui recipe apply free-tier-stack --dry-run
sui recipe apply free-tier-stack
```

## Shipped recipes

| Recipe | What it gives you |
|---|---|
| `free-tier-stack` | three providers, a fallback chain, a `free-default` combo, learning on |
| `privacy-strict` | `privacy.defaultTier: strict`, grounding on `block` |
| `coding` | a cascade: cheap model for questions, strong model for real coding work |
| `local-only` | an OpenAI-compatible local server (Ollama, llama.cpp, LM Studio), paid gate closed |
| `mcp-tools` | an MCP server used as a provider — edit the url/command and tool name |

## Three rules

| Rule | Why |
|---|---|
| **Never overwrite silently** — an existing provider, model or combo is kept, and the conflict is printed | a config file is someone's work |
| **Applying twice is a no-op** | the second run tells you it is already applied, with the count |
| **A dry run touches nothing** | `--dry-run` prints the changes and writes no file; the applier returns a new object and never mutates its input |

`--force` replaces existing entries and says `replaced` rather than `added`. Settings (like `budgets.dailyUsd`) are only set when absent, because a recipe should not quietly change a decision you already made.

## Writing your own

Drop a JSON file in `recipes/` in the repo, or in `~/.sui/recipes/` for your own machine. The loader reads both and the repo's copy wins on a name clash.

```json
{
  "name": "my-setup",
  "title": "My setup",
  "description": "What this gives you, in one sentence.",
  "requires": { "env": { "MY_KEY": "where to get it" } },
  "patch": {
    "providers": { "mine": { "type": "openai", "baseUrl": "https://…", "apiKeyEnv": "MY_KEY" } },
    "models": { "my-model": { "provider": "mine", "model": "…", "quality": 3 } },
    "combos": { "mine": { "strategy": "fallback", "targets": ["my-model"] } },
    "settings": { "compression.enabled": true },
    "append": { "apiKeys": [] }
  }
}
```

`requires.env` is checked and reported **before** anything is applied: a recipe that needs a key you do not have tells you that, rather than producing a gateway that silently cannot reach anything.
