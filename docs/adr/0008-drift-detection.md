# ADR-0008 — drift is EWMA plus a two-sided CUSUM, on a frozen baseline

**Status:** accepted · 2026-11-15

## Context

A circuit breaker answers "is it failing right now?". It cannot answer "has this provider got slower over the last hour", because no single request looks wrong. A provider that degrades 1% per call is invisible to a breaker until it has already cost an afternoon.

Two well-worn detectors cover the two shapes of the problem, and they are not interchangeable:

- **EWMA** tracks the smoothed level. Fast to react, and it answers "where is it now?".
- **CUSUM** accumulates small deviations from a baseline. It answers "how long has it been off?", which is exactly what a slow slide is.

## Decision

`packages/telemetry/src/drift.js` runs both, per series, for latency and for failure rate.

Four choices worth recording, because each one is a way this feature usually goes wrong:

1. **The baseline freezes after ten samples.** A baseline that keeps updating with the series follows the drift, and a detector that follows the drift detects nothing.
2. **The standard deviation has a floor** of 2% of the baseline level. A perfectly steady series has a standard deviation of zero, which makes every subsequent wobble infinitely significant — the first version alarmed on a 1% ramp after four samples for exactly this reason.
3. **A signalled CUSUM restarts.** Otherwise the statistic grows without bound and the printed number stops meaning anything.
4. **The alarm is latched**, and clears only when the smoothed level returns within two σ of the baseline. Clearing on a single normal sample would produce alarm flapping, which is how people learn to ignore alarms.

The monitor runs in a `drift_monitor` worker, off the request path, reading what the ledger has already recorded. `/api/status` carries the current alarms.

## Consequences

- A step change is caught in one sample; a +1%-per-sample slide in five. Both are asserted in `test/drift.test.js`.
- Noise is not drift: a seeded-noise test bounds the false-alarm rate, so a change that makes the detector twitchy fails the build.
- Drift is **reported, not acted on**. Nothing is disabled because it drifted — that decision stays with the operator, because "slower" and "worse" are not the same and only a human knows which one this is.
- Series are keyed `modelId:latency` and `modelId:failures`, so the two questions stay separate.
