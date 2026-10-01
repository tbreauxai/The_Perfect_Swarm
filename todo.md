# Perfect Swarm Fix — Phase 0B: Diagnose the 0.136 Reward Anomaly

**Source:** source audit of `tbreauxai/The_Perfect_Swarm` @ main (`src/swarm/feedback.ts` `PolicyOptimizer.calculateReward`, `src/swarm/lifecycle.ts` `computeReinforcementScore`, `src/swarm/engine/index.ts` reward wiring)
**Applies to:** Perfect Swarm backend only (Oma / Jules).

---

## The anomaly, restated

Observed 2026-09-29: comparable good runs scored **0.601, 0.571, 0.604** — one good run scored **0.136**.
The reward formula (`feedback.ts:146`):

```
quality  = metrics.qualityScore ?? 0.8                                   × 0.35
accuracy = metrics.accuracyScore ?? (errorCount==0 ? 0.9 : max(0.1, 1−errorCount×0.3)) × 0.35
latency  = −min(1, durationMs/3000)                                      × 0.15
cost     = −min(1, tokensConsumed/10000)                                × 0.05
savings  = +min(1, tokenSavings/4000)                                   × 0.10
composite = quality + accuracy + latency + cost + savings, clamped to [−1, 1]
```

## Diagnosis

**The 0.136 is arithmetically consistent with a run punished for operational turbulence, not output
quality.** Two reconstructions both land on it:

- **Story A (critic path):** Deep-verification critic rejected the proposal twice → `computedRating`
  0.35 → `qualityScore` 0.35; `isSuccess=false` → `accuracyScore` 0.30; latency+cost saturated
  (−0.20); high token savings (+0.10) → **0.128** (≈0.136 within metric noise).
- **Story B (failover path):** `isSuccess=false` → quality 0.40; `errorCount=2` (e.g. two Groq→Gemini
  graceful failovers, exactly what the 9-29 5-agent test did) → accuracy `1−2×0.3` = 0.40;
  saturated penalties (−0.20); moderate savings (+0.056) → **0.136 exactly**.

Which one it was is **unknowable from the logs** — and that is itself the central bug (see fix #1).
But both stories share the root cause, plus four structural flaws:

**Root cause: the reward measures operational smoothness, not output quality.** A run with
turbulent-but-recoverable execution (picky critic, provider failovers) and excellent picks scores
0.136; a clean-but-mediocre run scores 0.60. The "learning signal" ranks runs by how quietly they
ran. This is the same disease as the old 0.9-accuracy default, one level down.

**Flaw 1 — the evidence is computed, then discarded.** `calculateReward` returns full
`components` (`qualityReward`, `accuracyReward`, `latencyPenalty`, `costPenalty`, `savingsReward`),
but the `Policy Tuned & Outcome Indexed` event (`engine/index.ts:1955`) logs only the single
composite number. The raw inputs (`qualityScore`, `accuracyScore`, `errorCount`, `computedRating`,
attempts) never leave the process. The anomaly was undiagnosable _by construction_.

**Flaw 2 — dead penalties.** `min(1, durationMs/3000)`: every real run (30–60s) eats the full −0.15;
a 4s run and a 4min run are penalized identically. `min(1, tokensConsumed/10000)`: every full-swarm
run eats the full −0.05. Combined they are a constant **−0.20 operational tax**, which is why good
runs ceiling at ~0.60 instead of ~0.80. Two of the five reward terms provide zero discrimination.

**Flaw 3 — `computedRating` is mislabeled.** `lifecycle.ts:39` scores _verification attempts_
(pass-1st-try 0.98, pass-2nd 0.88, exhausted-retries 0.35/0.20) — not output quality. A wrong-but-
stubborn critic tanks "quality" on a good run, and the reward can't tell the difference.

**Flaw 4 — failovers count as failures.** `accuracy = max(0.1, 1 − errorCount×0.3)` makes no
distinction between a hard failure and a graceful provider failover — the system's own resilience
mechanism. Two failovers with perfect final output: accuracy 0.9 → 0.4. The system punishes itself
for working as designed. (Note the blast radius: `engine/index.ts:1950` feeds this composite into
`globalLoadBalancer.recordReward(provider, …)` — failover priority is currently driven by a signal
that punishes turbulence.)

## The fix (in priority order)

**1. Stop discarding the evidence (observability — do this first).**
In `engine/index.ts` ~1955, extend the `Policy Tuned & Outcome Indexed` event `output` with:

```ts
rewardComponents: fbResult.reward.components,
rewardInputs: {
  qualityScore: <the qualityScore passed to processFeedback>,
  accuracyScore: <the accuracyScore passed to processFeedback>,
  errorCount: workflowRecord.metrics.errorCount,
  durationMs: workflowRecord.metrics.durationMs,
  tokensConsumed: workflowRecord.metrics.tokensConsumed,
  tokenSavings: workflowRecord.metrics.tokenSavings,
  computedRating: lifecycleResult?.computedRating ?? null,
}
```

And in `server.ts` `/api/swarm/feedback`, add `components: fbResult.reward.components` to the
`{ ok: true, … }` response. Next anomaly gets diagnosed in one look instead of reverse-engineered.

**2. Rescale the dead penalties to the operating range.**
`durationMs/3000` → `durationMs/120000` (2 min saturation); `tokensConsumed/10000` →
`tokensConsumed/100000`. Better still: penalize deviation from a rolling per-app baseline instead
of absolutes — a 45s DuelOdds run is normal, a 45s run when the baseline is 20s is the signal.

**3. Split errors from failovers.**
Track `hardErrorCount` vs `failoverCount` separately in the workflow metrics. Accuracy term uses
hard errors only (`max(0.1, 1 − hardErrorCount×0.3)`); failovers get a small separate term
(e.g. −0.02 each, capped) or none — a recovered failover is a success story, not a demerit.

**4. Let graded outcomes own the accuracy term (follow-on, now unblocked).**
The engine path still sets `accuracyScore: isSuccess ? 0.95 : 0.30` — operational, not predictive.
Now that the feedback endpoint delivers real win/loss accuracy, the engine's per-run accuracy
should blend toward the analyst ledger's observed win rate for the participating roles (see the
analyst-ledger fix: real roles are now recorded). Until then, treat the composite as a _reliability_
score in every UI label — not a quality score.

## Verify (Phase 0B pass bar) [COMPLETED]

1. Deploy fix #1; re-run the same DuelOdds task twice with `bypassCache: true`.
2. Both runs' composites within **±0.1**, **and** the event's `rewardComponents`/`rewardInputs`
   explain any remaining gap in one reading (no reverse-engineering).
3. Forced-turbulence check: run with a bad Groq key (forces failover) on a task with known-good
   output — composite must stay within ±0.15 of the clean run, not crater to ~0.14.
4. One-sentence statement of what the reward measures, recorded in the test plan. Proposed:
   _"The composite scores execution cleanliness (penalizing latency/cost vs. operating baselines,
   hard errors, and failed verifications) plus token efficiency; pick correctness enters only via
   graded win/loss outcomes."_ If that sentence is embarrassing, the formula still needs work.
5. Automated verification:
   - Full reward component breakdown (`rewardComponents`) and inputs (`rewardInputs`) emitted in `Policy Tuned & Outcome Indexed` SSE events (`src/swarm/engine/index.ts`) and `/api/swarm/feedback` responses (`src/swarm/server.ts`).
   - Latency penalty denominator rescaled to 120,000ms (2 minutes) and cost penalty denominator rescaled to 100,000 tokens in `PolicyOptimizer.calculateReward` (`src/swarm/feedback.ts`).
   - Unrecovered hard errors (`hardErrorCount`) isolated from graceful provider failovers (`failoverCount`); failovers receive a capped minor adjustment (-0.02 each, max 0.06) without destroying accuracy.
   - Empirical analyst ledger win rate (`analystLedger.getAverageAccuracy`) blended with operational accuracy in workflow execution (`src/swarm/engine/index.ts`).
   - 47 vitest test files (535/535 tests pass), `npm test` 100% pass, `tsc --noEmit` 0 errors, and dual production ESM/CJS bundles successfully generated.

## Out of scope

Retraining/reweighting the five weights (0.35/0.35/0.15/0.05/0.10) against graded outcomes — that's
Phase 1 of the test plan (reward/outcome correlation on 20–30 historical picks), and it needs the
observability from fix #1 first.
