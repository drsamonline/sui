# What the numbers mean

Every claim in the README is a measurement, and a measurement without its sample size invites a reader to treat a sample as a fact. This page says what each number rests on, and where it stops being useful.

## The eval pass rate

`sui eval` runs 50 prompts against a real combo, one deterministic grader each. It ships in the CLI package, so it measures the same thing from a registry install as from a checkout (`npm run eval` still works and runs the same engine).

```
pass rate 86% (43/50) · 95% CI 74–93%
```

**One prompt is two percentage points.** A run of 43/50 and a run of 44/50 are the same result, and the confidence interval says so. Quote the interval, or do not quote the rate.

Per-category rates matter more than the aggregate, because the aggregate is dominated by the largest category — coding has ten prompts, tools and math have two. The runner prints every category with its own interval and marks the ones under five prompts as indicative only.

| Category | Prompts | Read the rate as |
|---|---|---|
| coding | 10 | meaningful |
| review, reasoning, extraction | 6 | meaningful |
| summarise, json | 5 | borderline |
| safety, long_context | 4 | indicative |
| tools, math | 2 | indicative only |

**A run where nothing answered has no pass rate.** If every request failed, `sui eval` exits 2 and reports `passRate: null` with the first error, because 0/50 in that case measures the network. The dashboard shows the note instead of a percentage, and there is no `0%` anywhere to be misread.

**What a pass rate is not:** it is not a measure of answer quality. Each grader checks one property — that the answer contains `setTimeout`, that the JSON parses with two keys, that a request was refused. A model can pass all fifty and still be unhelpful, and fail ten while being right in a way the regex did not anticipate.

## The regression gate

`sui eval --update-baseline` records the ids that passed. In a checkout the baseline is `evals/baseline.json`; from an install it is `eval-baseline.json` in your Sui home, because a baseline is a record of what *this* machine measured. A prompt that passed then and fails now fails the build (invariant I10).

With fifty prompts, a single regression is inside sampling noise. The gate still fails on it, deliberately: a prompt that used to pass must not stop passing, and the message says when the drop is one prompt rather than several, so nobody reads noise as a trend.

## The soak

`npm run soak` measures the gateway's **own** overhead — the server-side handler time, not the client's view of the round trip.

```
overhead   p50 0.29ms · p95 2.19ms · p99 6.13ms (budget 15ms)
```

| Figure | Rests on | Use it for |
|---|---|---|
| p50, p95 | 1,200 samples in a one-minute run at 20 rps | a claim about the budget |
| p99 | the 12th-worst of 1,200 | a description, not a bound |
| the 15 ms budget | ADR-0002's target | the gate that fails a build |

A one-minute run on one machine says nothing about a three-day run on yours. That is why the 72-hour soak exists in the roadmap and why the p95 figure in the README is labelled with its sample size.

## The drift detector

EWMA plus a two-sided CUSUM, with a baseline frozen after ten samples. Its false-alarm rate was measured at **2 in 200** noisy samples and is asserted by a seeded test rather than claimed.

## The dashboard smoke test

Three states — healthy, empty, degraded — in a real browser. It fails on any console error, page error or failed request. It does not measure rendering performance or visual correctness; a screenshot review does that, and is not automated.

## What none of this measures

- **Answer quality.** No human rating, no LLM-as-judge. The graders check properties, not usefulness.
- **Your provider's latency.** The soak uses a mock provider with a fixed delay, so its numbers are the gateway's overhead alone.
- **Cost accuracy.** Costs come from each provider's published per-1k prices and the token counts the provider reports. A provider that miscounts tokens gives a wrong cost, and the ledger cannot tell.
