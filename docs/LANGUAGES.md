# Languages

Sui speaks English, Hindi, Gujarati, Marathi, Tamil and Telugu for the strings a person actually meets. Everything else is English.

```bash
SUI_LANG=hi npx @drsamonline/cli --help
```

or in the config:

```json
{ "locale": "gu" }
```

`sui lang` lists what this build ships. Anything not listed falls back to English rather than failing: a typo in a language code must not stop a gateway from starting.

## What is translated, exactly

| Surface | Translated |
|---|---|
| CLI tagline, `--help` header | yes |
| First-run messages (looking for keys, found one, endpoint ready, start it with) | yes |
| The errors a beginner hits (no config, port in use, open relay, at capacity) | yes |
| Dashboard: the four headline labels and the attention sentence | yes |
| Dashboard: the small numeric foot lines (`0 failed · 0 attempts`, `cache hit 0%`) | **no** |
| The detail tables below the fold | **no** |
| Provider names, model names, config keys, commands | never — they are identifiers |

That boundary is deliberate and tested. A half-translated sentence is worse than an English one, so a key is either fully translated in a language or it falls back to English whole; the module's test asserts that every language translates exactly the same key set, with the same placeholders.

## Why not everything

Two reasons, both practical:

- **The detail tables are mostly identifiers.** `x-sui-cost-usd`, `demo-b`, `fallback`, `weighted` — translating them would make the page harder to read, not easier.
- **A translation you cannot check is a guess.** These strings were translated and then reviewed for placeholders and length; the five languages share a script family with the reviewer's own, which is the only reason the review is worth anything. A build that claimed 67 languages would be claiming more than it checked.

## Adding a language

1. Add the code and its name to `LANGUAGES` in `packages/core/src/i18n.js`.
2. Translate every key in the English table — the test fails if the sets differ.
3. Keep `{placeholders}` exactly as they are; the test fails if one changes.
4. If the script reads right to left, add the code to `RTL`; `direction()` is independent of the string table, so a browser is told the truth even before the strings land.
5. Run `npm test`.
