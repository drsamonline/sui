# Disclaimer

Version: 1.0 · Effective: 2026-11-16 · Owner: Dr Sohil Momin

Sui is a **routing gateway**. It forwards prompts to model providers and returns their answers. It does not train models, does not generate answers itself, and does not guarantee any answer it carries.

## What the output is, and is not

| Sui does | Sui does not |
|---|---|
| route a prompt to a provider and return the answer | verify that the answer is true |
| score an answer on deterministic signals and say whether it is **verified** | certify an answer as correct, safe or fit for a purpose |
| report which provider answered, what it cost and how long it took | accept responsibility for what a provider returns |
| check that a cited URL, quote or number appears in the context it was given | check that the context itself is true |

`verified: true` means the answer passed a set of mechanical checks. It does **not** mean the answer is correct. An answer marked unverified is not necessarily wrong, and an answer marked verified is not necessarily right.

## Reliance

Nothing produced through this gateway is professional advice — medical, legal, financial, psychological or otherwise. Do not rely on it to diagnose a condition, decide a legal question, move money, or operate anything where being wrong causes harm.

**If you are unwell, consult a registered medical practitioner.** In an emergency, call 112 (India) or your local emergency number. Do not delay or discontinue treatment because of anything an AI model returned.

## Third-party providers

Answers come from third-party providers whose terms, retention and training practices Sui does not control. Sui reports what each provider declares (`/api/status` → `privacy.providers`) so you can decide what to send where, and it refuses providers that do not meet a tier or region you require. That is a disclosure, not a guarantee about the provider's conduct.

Do not send anything you would not send directly to that provider.

## Availability and cost

The gateway is software you run. It makes no uptime promise, and its budget controls are advisory guardrails rather than a spending guarantee. Providers change prices, quotas and terms without notice.

## The software itself

Provided under the MIT License, **without warranty of any kind**, as set out in [LICENSE](LICENSE). The authors are not liable for any claim, damage or other liability arising from use of the software or from any answer it carried.

## Reporting a problem

- A security issue: [SECURITY.md](SECURITY.md)
- An incorrect statement in this repository: open an issue at https://github.com/drsamonline/sui/issues

This document is not legal advice. It describes the software as shipped and is updated in the same commit as any change to what the software does.
