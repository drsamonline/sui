# Publishing

## Before anything: the scope must be yours

`@sui/cli` can only be published by the npm account or organization named `sui`. A scope is not a namespace you pick. It is the owner. If the token screen says *"no organization selected"* and offers you nothing, that is what it means: your username is not `sui` and you have no organization.

Two ways out:

| Route | Cost | Keeps `@sui/*`? |
|---|---|---|
| **Create a free organization named `sui`** (npmjs.com → your avatar → Add Organization → free tier for public packages) | 1 minute | yes |
| Rename every package to `sui-*` (unscoped) | one commit here | no |

`npm run publish:dry` tells you which situation you are in: every package shows `free` when the name is unpublished, and the publish fails at step one with a 403 when the scope belongs to someone else.

## The short path: add one repository secret, push a tag, done. `.github/workflows/publish.yml` runs the gates, checks the tag against `package.json`, and publishes all 18 packages from a GitHub runner.

```bash
# 1. once: an npm automation token (npmjs.com → Access Tokens → Granular, read+write)
#    add it as the repository secret NPM_TOKEN

# 2. whenever you want to publish
git tag -a v0.12.0 -m "0.12.0"
git push origin v0.12.0
```

Nothing is published from a laptop, no token sits in your shell history, and a tag that disagrees with `package.json` stops the run before anything irreversible happens.

The rest of this page is the manual route, and what the publisher refuses to do either way.

`npm run publish:dry` checks everything and publishes nothing. `npm run publish:real` publishes in dependency order.

## What the script refuses to do

npm publish is permanent: a version cannot be reused and a bad tarball cannot be withdrawn. So the script stops on any of these:

| Refusal | Why |
|---|---|
| a dirty working tree | what you tested is not what you ship |
| a package version that disagrees with the root | a published set that contradicts itself |
| a version that already exists on the registry | it would fail halfway through, leaving a partial release |
| a tarball containing tests, fixtures, `.env` or `.npmrc` | what is in the tarball is what the world gets |

## Before the first publish

**You need an npm account and a token.** This repository has neither, so nothing has been published from here.

```bash
npm login                      # or: npm config set //registry.npmjs.org/:_authToken=<token>
npm whoami                     # should print your username
npm run publish:dry            # 18 packages, all 'free'
npm run publish:real
```

**Decision (2026-11-15): scoped, `@sui/*`.** A registry search for `scope:sui` returns zero packages, so the scope looks unused; keeping 18 tiny packages in one namespace beats squatting 18 unscoped names. If the org turns out to be taken, the fallback is a mechanical rename, not a redesign.

**The `@sui` scope must be yours.** Publishing `@sui/core` requires that your account owns or belongs to the `@sui` organisation on npm. A 404 on `npm view @sui/core` only proves the *package* is unpublished — it says nothing about who owns the scope.

If the scope is not yours, there are two routes:

| Route | What changes |
|---|---|
| create the org | `npm org create sui` (or claim it on npmjs.com), then everything works as written |
| go unscoped | rename in each `package.json`: `sui-core`, `sui-router`, `sui-gateway-cli`… and update the `@sui/*` dependency ranges |

`sui-cli` is **taken** (someone else publishes 1.0.3 there). `sui-gateway`, `sui-router-gateway` and `sui-free-tier-gateway` are free as of 2026-11-15.

## What gets published

| Package | Why it is separate |
|---|---|
| `@sui/core` | config, invariants, errors, recipes — the vocabulary |
| `@sui/router` | routing, breakers, cascade, learning |
| `@sui/providers` | adapters, quota parsing, token refresh |
| `@sui/telemetry` | ledger, cache, history, drift |
| `@sui/guardrails`, `@sui/compression`, `@sui/promptcache`, `@sui/verify`, `@sui/redteam`, `@sui/canary`, `@sui/prober`, `@sui/vault`, `@sui/sdk`, `@sui/catalog`, `@sui/kits` | one concern each |
| `@sui/mcp` | the protocol surface |
| `@sui/sandbox` | the contained process |
| `@sui/cli` | the `sui` binary |

The vendored kits are **not** published separately: they are files inside `@sui/kits` under the owner grant, and `vendor/` is not in any tarball.
