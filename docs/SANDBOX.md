# The sandbox

`sui sandbox <file.js>` runs a snippet of model-authored code in a contained process. `sui sandbox --self-test` runs the attack suite and reports what happened to each attempt.

## The honest starting point

**`node:vm` is not a security boundary.** It stops accidents, not adversaries — escapes have been demonstrated many times, and any design that rests on it will be broken. So the boundary here is a **process**, not a context.

| Layer | What it does | Enforced by |
|---|---|---|
| separate process | a crash, a hang or an OOM is the child's problem | `spawn` |
| Node permission model | no filesystem outside the work directory, no child processes, no worker threads, no native addons | `--experimental-permission` |
| **network namespace** | no interfaces to reach, so no exfiltration | `unshare -n -r` |
| stripped environment | `PATH`, `LANG`, `TZ` and nothing else; `HOME`/`TMPDIR` point at the work directory | `spawn({env})` |
| hard limits | wall clock, heap, output bytes | parent kill, `--max-old-space-size`, capture cap |
| `vm` context | no `require`, no `process`, no `import`, no `eval`, no `new Function`, no WASM | `codeGeneration: {strings:false, wasm:false}` |

The `vm` context is the *last* layer, not the first. That ordering matters: if someone finds a `vm` escape, they land in a process with no filesystem, no network and no environment.

## What it is not

| Claim | Reality |
|---|---|
| "kernel-level jail" | **No.** `unshare` needs root or user namespaces. Where it is unavailable, `sandboxCapabilities()` says `networkIsolated: false` and the run says so too. |
| "safe to run arbitrary code from the internet" | **No.** This is for code a model wrote on your behalf, on a machine you control. |
| "no CPU cost" | No. An infinite loop costs one core for as long as the wall clock allows, then dies. |

`sandboxCapabilities()` reports `permissionModel`, `networkNamespace`, `networkIsolated` and `fullyIsolated` for the machine it is on, and every run carries those facts in its result. With `requireNoNetwork: true`, a machine that cannot isolate **refuses to run at all** — a sandbox that cannot prove its boundary is not a sandbox.

## The attack suite

Fourteen cases, each the simplest form of a class. They are test fixtures, not exploits: no working payload, no target, no obfuscation.

| Attempt | Contained by |
|---|---|
| read `/etc/passwd` | no `require` in the context |
| dynamic `import()` | no module loader |
| spawn a child process | no `require`, plus the permission model |
| `eval`, `new Function` | `codeGeneration.strings: false` |
| compile WASM | `codeGeneration.wasm: false` |
| loop forever | `vm` timeout, then the wall clock |
| recurse until the stack dies | a `RangeError` in the child |
| allocate until the heap dies | `--max-old-space-size` |
| flood the output | capture cap |
| `process.exit()` | no `process` |
| read the environment | no `process`, and the environment is stripped |
| `setInterval` | not provided — an async loop is what a synchronous timeout cannot stop |
| open a socket | no `fetch`, plus the network namespace |

All fourteen are contained on this machine, and `npm test` fails if one stops being contained. The suite is a regression test on the boundary, not a proof that the boundary is unbreakable.

## Wiring it into the gateway

The sandbox is **not** on the request path. Nothing in `/v1/chat/completions` executes code, and that is deliberate: a gateway that runs what a model writes is a different product with a different threat model. To use it, call `runCode()` from your own tool layer — or run a bounded agent through `POST /api/runs` and have *it* call `sui sandbox` as a subprocess.
