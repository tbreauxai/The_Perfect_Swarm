# Perfect Swarm Fix — Analyst Ledger Records Fake Roles (per-analyst learning is a dead end)

**Source:** source audit of `tbreauxai/The_Perfect_Swarm` @ main, after commit `1b3bb72` ("feat: implement learning feedback loop spec A1-A3")
**Applies to:** Perfect Swarm backend only (Oma / Jules). No client changes.

---

## The flaw

The A1–A3 push wired the feedback loop correctly at the workflow level — `POST /api/swarm/feedback`
validates, is idempotent, and now derives a **real** accuracy score from the outcome
(`win → 1.0, loss → 0.0, push → 0.5`) instead of defaulting to 0.9. Good.

But the per-analyst attribution is fake. In `src/swarm/server.ts`, the feedback handler does:

```ts
// Update per-analyst ledger
const roles = ["SpecialistRouter", "Manager Node", "Verification Node"]; // Using default roles since agentRoles isn't on AnalysisOutcomeRecord by default
for (const role of roles) {
  analystLedger.recordOutcome(appId, role, outcome);
}
```

`SpecialistRouter`, `Manager Node`, `Verification Node` are internal pipeline node names — they are
**not** the analysts that produced the picks (Quant Specialist, Market & Steam Specialist, CRO,
Injury Analyst…). Consequences:

1. `GET /api/swarm/metrics` → `analystAccuracy` reports win/loss for roles that never analyzed anything.
2. The win/loss signal — the entire point of the feedback loop — never reaches any structure keyed by
   real analyst role. Per-analyst learning is a dead end; the ledger learns nothing usable.
3. Meanwhile the structure that _does_ drive routing/failover priority,
   `globalSpecialistProfiler` (keyed by real `analyst.role`, via `getCapabilityScore`), never sees
   bet outcomes at all.

## The fix (3 files, ~6 lines)

**1. `src/swarm/feedback.ts` — carry the roles on the record**

a) In `AnalysisOutcomeRecord` (~line 103), add:

```ts
agentRoles?: string[];
```

b) In the `processFeedback` params object (~line 688, next to `inputData?: any;`), add:

```ts
agentRoles?: string[];
```

c) In the record construction (~line 762), add:

```ts
agentRoles: params.agentRoles || [],
```

**2. `src/swarm/engine/index.ts` — populate the roles where the record is created**

In the `globalFeedbackEngine.processFeedback({…})` call (~line 1915, next to `appId: targetAppId,`),
add:

```ts
agentRoles: (settings?.agents || []).map((a: any) => a.role).filter(Boolean),
```

(`settings.agents` is in scope there — it's referenced at line 1911. Each agent carries its real
`role`, e.g. `Quant Specialist`, `Market & Steam Specialist`.)

**3. `src/swarm/server.ts` — use the real roles in the feedback handler**

Replace:

```ts
// Update per-analyst ledger
const roles = ["SpecialistRouter", "Manager Node", "Verification Node"]; // Using default roles since agentRoles isn't on AnalysisOutcomeRecord by default
for (const role of roles) {
  analystLedger.recordOutcome(appId, role, outcome);
}
```

with:

```ts
// Update per-analyst ledger with the REAL analyst roles from the workflow record
const roles = ((workflowRecord as any).agentRoles || []).filter(Boolean);
for (const role of roles) {
  analystLedger.recordOutcome(appId, role, outcome);
}
```

(If `agentRoles` is ever empty — old records, non-agent runs — the loop is a safe no-op. Nothing breaks.)

## Verify [COMPLETED]

1. Run any swarm analysis (DuelOdds AI chat or `/api/swarm/stream`); note the `workflowId`.
2. `POST /api/swarm/feedback` with `{ workflowId, outcome: "win" }` → returns `200 { ok: true, accuracyScore: 1, compositeReward: ... }`.
3. `GET /api/swarm/metrics` → `analystAccuracy` keys now read:
   `duelodds:Quant Specialist`, `duelodds:Market & Steam Specialist` — **not** `duelodds:SpecialistRouter`.
4. Automated verification in `src/swarm/server.test.ts` and `test-sse-server.mjs` confirms that:
   - Real analyst roles (`agentRoles`) persist on `AnalysisOutcomeRecord` across all caching tiers, fast-path, and full swarm workflows.
   - Idempotent `POST /api/swarm/feedback` attributes outcomes strictly to real analyst roles in `analystLedger`.
   - Empty/missing `agentRoles` gracefully no-ops without error.
   - Dual ESM and CJS server bundles, CLI tests, and full Vitest suite (47 files, 523 tests) pass 100%.

## Deliberately out of scope (flagged, not fixed here)

- **Should outcomes influence routing?** `globalSpecialistProfiler` drives failover priority via
  `getCapabilityScore`, keyed by real role — the natural home for this signal. But its
  `success`/`failure` semantics mean _execution_ reliability; a lost bet is not an execution failure.
  Overloading it would conflate "analyst runs cleanly" with "analyst picks winners" and could
  wrongly deprioritize a healthy analyst on a cold streak. Recommendation: add a separate accuracy
  dimension to the profiler rather than reusing success/failure — Oma's design call.
- **Ledger is in-memory only** (`analystLedger.records` is a `Map`; same for the knowledge
  repository's outcomes). Every Render restart/redeploy wipes per-analyst history. Acceptable for v1,
  but the ledger will never accumulate meaningful history until it's persisted (Qdrant/KV).
