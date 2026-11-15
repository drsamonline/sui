# ADR-0012 — four routing policies, each with an off switch and a reason on the record

**Status:** accepted · 2026-11-15

## Context

Four batches add routing policy: free-first ordering (B3.1), the speculative cascade (B3.5), the grounding check (B7.6) and quota windows (B9.4). Each one changes where a request goes or what happens to the answer. Policy that acts silently is policy nobody can debug.

## Decision

**Free-first (B3.1).** A free target ranks before a paid one regardless of declaration order, because a paid key that happens to be first in a list should not be the thing that spends money. Declared order is preserved *within* a tier; a combo can opt out (`freeFirst: false`), and the gateway can too (`routing.freeFirst`). Health still beats tier.

**Cascade (B3.5).** A deterministic classifier — length, code, schema, multi-step markers, arithmetic, multiple questions — picks the cheap or the strong target before the request leaves. It has no model of its own, because a classifier that costs a request has defeated the point of saving one. Measured 0.03–0.3 ms on ordinary prompts, 3 ms on a 20,000-word one, against a 50 ms budget that a test asserts. A cascade list naming models the combo does not have is ignored **with a signal**, rather than emptying the route.

**Grounding (B7.6).** Every URL, quoted span of 8+ characters and unit-bearing number in the answer must appear in the context the answer was given. An ungrounded answer takes a 0.45 confidence penalty, which usually pushes it below the threshold and escalates it. It is a **penalty, not a refusal**: a wrong citation is a strong signal, and refusing outright would turn one false positive into an outage. With no context the check reports `checked: false` — an unchecked answer is not a failed one, but it is not a verified one either.

**Quota windows (B9.4).** A `429` carrying `Retry-After` closes that target for exactly that long, reported in the skip reason. It is **not a breaker trip**, because a quota window is a fact and the breaker is an inference from failures (I13). The window reopens with a log line, and `quotaWindows` appears in `/api/status`.

## Consequences

- Every policy reports itself: `sui.route.freeFirst`-ordering appears in `considered`, `sui.route.cascade` carries the decision and its signals, `sui.verification.grounding` carries the findings, and the skip reason names the quota window.
- Each is off by default except free-first, which is on because spending money should require a decision, not a default.
- A grounding check's worst failure mode is accusing a correct answer; the URL matcher had to stop swallowing trailing punctuation before it was allowed to ship.
