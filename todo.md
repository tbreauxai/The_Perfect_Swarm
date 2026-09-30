# Perfect Swarm Fix — Manager Synthesis Has No Substance (generic "Executive Analysis")

**Source:** source audit of `tbreauxai/The_Perfect_Swarm` @ main (`src/swarm/engine/constants.ts`, `src/swarm/schemas.ts`, `src/swarm/engine/index.ts`, `src/swarm/parser.ts`) + DuelOdds client `normalizeSwarmOutput`
**Applies to:** Perfect Swarm backend only (Oma / Jules). No client changes needed — the DuelOdds
client already reads `analysis → executiveSummary → summary` off the manager output.

---

## The flaw (three compounding causes)

**1. The system instruction asks for formatting, not thinking.** `MANAGER_SYSTEM_INSTRUCTION`
(`src/swarm/engine/constants.ts:21`) says: _"Synthesize the reports… into a single unified Generative
UI payload. Instead of outputting raw text, you MUST output a Generative UI payload. Output strict JSON
matching this JSON Schema."_ That is the entire substantive guidance. Nothing tells the manager to
arbitrate disagreements, justify the final call, cite evidence, or state uncertainty. So it formats —
and the prose comes out as two generic sentences, because depth was never requested.

**2. The schema actively discards prose.** `ManagerResponseSchema` (`src/swarm/schemas.ts:52`) has
`ui_title` + `components` only — no summary field. Zod's default behavior strips unknown keys, and
`guardManagerResponse` (`src/swarm/parser.ts:423`) returns `parsed.data` on success. So even when the
model _does_ write a synthesis (as `summary`/`executiveSummary`/`analysis`), the backend strips it
before any client ever sees it. The client's `analysis → executiveSummary → summary` lookup chain
then finds nothing.

**3. The disagreement data is in the prompt but never used.** The engine already computes
cross-analyst consensus (`extractAnalystConsensus`, step 4b) and injects it via
`renderPromptConsensusBlock` — but the manager is never instructed to arbitrate it in prose. The
arbitration signal exists; nothing asks for it in words.

## The fix (2 files)

**1. `src/swarm/schemas.ts` — give the synthesis a field that survives parsing**

In `ManagerResponseSchema`, right after `ui_title` (~line 53), add:

```ts
summary: z.string().optional().describe("Executive synthesis, 4-8 dense sentences: the bottom-line call, where analysts disagreed and whose view won with the deciding evidence, key numbers cited, and what would change the call. No generic filler."),
```

(Optional, not required: it can never break validation of currently-valid outputs — it just stops
being stripped when present. The instruction below is what compels the model to emit it.)

**2. `src/swarm/engine/constants.ts` — demand substance in the instruction**

Append to `MANAGER_SYSTEM_INSTRUCTION`, after the JSON-schema block and before/after the example
(and add `"summary": "..."` to the example object so the model sees the field in context):

```
SYNTHESIS QUALITY BAR — the "summary" field is the most important part of your output:
- Bottom-line call first: what should the user do or conclude.
- Arbitrate disagreement: the prompt contains a cross-analyst consensus block. Name exactly where
  analysts disagreed, whose view won, and the specific evidence that decided it. Never flatten
  real disagreement into vague agreement.
- Cite concrete evidence: numbers, lines, odds, thresholds from the analyst reports — not adjectives.
- State what would change the call: the one or two facts that would flip your conclusion.
- Forbid filler: no "the analysts provided valuable insights", no restating the task, no unquantified
  hedging ("may", "could", "potentially" without numbers attached).
- 4-8 sentences. Dense beats long.
```

**Optional follow-up (not required for this fix):** extend the Deep Analysis Verification critic prompt
(`src/swarm/engine/index.ts`, ~line 1645, the `lifecycle.executeAndVerify` verification string) with
one clause: _"and does the summary arbitrate analyst disagreements with deciding evidence rather
than generic filler."_ Fidelity-checking stays; depth-checking joins it.

## Verify [COMPLETED]

1. Run any analysis (DuelOdds AI chat, or `POST /api/swarm/stream` directly).
2. Inspect the final `swarm_complete` SSE payload: `finalAnalysis.summary` must be 4–8 dense
   sentences that **name a specific analyst disagreement and how it was arbitrated** — not two
   generic sentences. (On a run with no real disagreement, it must still state the call, the key
   evidence, and what would change it.)
3. DuelOdds UI: the "Executive Analysis" section now shows this summary via the client's existing
   lookup chain — confirm no client change was needed.
4. Regression: `guardManagerResponse` still `safeParse`s cleanly; `/api/swarm/analyze` output shape
   unchanged apart from the added optional field.
5. Automated verification:
   - `ManagerResponseSchema` in `src/swarm/schemas.ts` validates and preserves `summary`.
   - `MANAGER_SYSTEM_INSTRUCTION` in `src/swarm/engine/constants.ts` defines explicit `SYNTHESIS QUALITY BAR` and provides concrete example with `summary`.
   - `guardManagerResponse` in `src/swarm/parser.ts` retains `summary` across native and salvage fallback branches.
   - Deep Analysis Verification critic prompt in `src/swarm/engine/index.ts` audits summary arbitration depth.
   - Dual ESM and CJS server bundles, CLI tests, and full Vitest suite (47 files, 532 tests) pass 100%.

## Why this shape (and not a bigger rework)

- The consensus/arbitration machinery already exists and is already in the prompt — this fix only
  makes the manager _verbalize_ it. No new pipeline stages, no new models, no latency cost.
- Optional schema field = zero breakage risk for other swarm consumers; the behavior change comes
  from the instruction, which is DuelOdds-agnostic.
- If Oma later wants the summary to influence the critic score or the reward signal, the field now
  exists to hang that on.
