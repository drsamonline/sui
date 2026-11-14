# Privacy

**Version 1.0 · effective 2026-11-14 · owner: the repository maintainer**

> Draft, written against the code as shipped at this commit. It describes what the software does; it does not conclude that any deployment is compliant with any law. Have a qualified advocate review it before you publish or operate a public service on top of it.

## What Sui is, in one line

Sui is a gateway that runs **on your own machine**. It receives requests from your tools, chooses an AI provider, forwards the prompt to that provider, and returns the answer.

## What leaves your machine

| Where | What | Why |
|---|---|---|
| The AI provider you route to | the prompt and its context, as sent | it has to, to answer |
| Provider endpoints, when probing is enabled | synthetic probe fixtures (no customer content) | to check a route before using it |
| **Nowhere else** | — | there is no analytics, no telemetry upload, no crash reporting, no licence check |

There is no account, no registration and no Sui-operated server. The maintainers of Sui receive nothing from your installation.

**The provider is a third party.** Once a prompt is forwarded, that provider's own terms and retention policy apply. Sui cannot retract it. Read the provider's policy before sending anything you would not want retained.

## What is stored on your machine

Everything below lives under `$SUI_HOME` (default `~/.sui`), or wherever you point the config.

| Store | Contents | Erase with |
|---|---|---|
| `ledger.jsonl` | one line per attempt: timestamp, provider, model, combo, tokens, cost, latency, time-to-first-token, cache and verification flags, an API-key **name**, and a salted hash of the prompt with its length | delete the file |
| `vault.json` | paid provider credentials, sealed with AES-256-GCM | `sui vault remove <provider>`, or delete the file |
| `vault.key` | the vault passphrase, mode 0600 — unless you supply `SUI_VAULT_PASSPHRASE` | delete it after setting your own passphrase |
| your `sui.config.json` | routing config, API-key **hashes** (SHA-256), budgets, guardrails | edit or delete it |

Prompt **text** is not written to the ledger unless you set `guardrails.logPrompts: true`. That is off by default and the invariant audit warns when it is on.

The response cache is in memory only. Its optional lexical tier holds recent prompt text **in memory** to compare prompts; it is off by default, and it never touches disk.

## Personal data

If you route prompts containing other people's personal data, you are the one deciding to send it — Sui is a tool you operate, not a service that collects it. In plain terms, that makes you responsible for:

- telling those people what you send and to whom (the provider category, not just "an AI");
- having a lawful basis for the processing in your jurisdiction;
- honouring access and erasure requests, which for Sui means the provider (their copy) and your local ledger and cache (your copy);
- not sending more than the task needs.

Sui helps with the last one: compression removes repeated context, prompt text is hashed rather than stored, and the provider pool is visible in the dashboard so you can see where prompts can go.

## Children

Sui has no age gate because it has no accounts and no user data of its own. If you deploy it in a product used by children, that obligation is yours.

## Security

See [`SECURITY.md`](../SECURITY.md) for what the gateway is and is not in security terms, and how to report a vulnerability. Two facts matter for privacy: the dashboard and `/api/*` are unauthenticated by default (bind to `127.0.0.1`), and the vault protects a copied vault file, not a compromised user account.

## Changes

Any change to what is stored or sent is a change to this document in the same commit. The version and date at the top move with it.
