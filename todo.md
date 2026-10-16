# IDE RUN-THROUGH: The Perfect Swarm: provider reliability for AI Lab chat (PS1 partial answer, PS2 limiter + breaker, GH retire GitHub Models, PS3 manager chain + analyst pool, PS4 placeholder, PS5 tests)

Repo: tbreauxai/The_Perfect_Swarm
Base: main @ 34b0eb8c25a0ef9d2b540b982433a7f7db5f3979 (34b0eb8, "fix(groq): cap prompt at 6k chars, clamp max_tokens under 6k TPM, and enforce single Groq seat", 2026-10-16 10:35 CT)
Source: Architect plan "Architecture Plan: provider reliability for AI Lab chat (2026-10-16)" plus "2026-10-16 1:15 PM CT - Tyler: free tiers only"
and Scout's "2026-10-16 1:30 PM CT - Discovery: ... GitHub Models" in audit_runbook_perfect_swarm.md (sole source of scope; nothing outside it is in scope).
Branch: create a NEW branch from 34b0eb8, e.g. `fix/provider-resilience-ps1-ps5`.
Revision: v3. GitHub Models was retired on 2026-07-30 (Scout, 1:30 PM CT). The new GH group (steps 12-17) disables the github provider and drops its
defaults. github is removed from MANAGER_CHAIN, which is now gemini-2.5-flash, gemini-2.5-flash-lite, mistral-small-latest, groq openai/gpt-oss-120b,
and from the PS2 limiter table. Tests that hard-coded github are updated (router.test.ts in step 14, plus the new PS5 tests).
v2 included Architect's answers (2026-10-16 ~1:10 PM CT):
(1) `partial:true` / status 'partial' ONLY when the final answer did not come from the manager (whole manager chain failed,
best analyst output returned). A seat that fails with no backup goes into `degraded: string[]` (seat ids) with status
'complete'. A seat that recovered via a fallback is neither. SSE swarm_complete and /analyze expose `status` + `degraded`.
(2) The manager chain keeps its configured order (no load-balancer re-sort) but still skips open circuits and dead models.
(3) Morning runs (settings.responseSchema === 'morning_judge') keep PS1 partial behavior and PS2 breakers but do NOT borrow
from the global analyst pool.
(4) Groq gets an explicit mode ('chat' | 'morning'). Chat: 18,000-char prompt cap, max_tokens = min(2000, 7000 - ceil(promptChars/4)),
and below 800 Groq is skipped to the next fallback. Morning: the existing 6k cap and computeGroqMaxTokens are unchanged.
Steps: 27 (PS1: 6, PS2: 5, GH: 6, PS3: 3, PS4: 1 placeholder, PS5: 6). 26 commits (step 21 is a placeholder with no commit).

## HOW TO RUN THIS (one continuous pass)

Do every step from 1 to 27 in one go. Don't stop to submit, report, or open a PR between steps or groups. There's one branch and one PR at the very end.

1. Create a NEW branch from 34b0eb8, e.g. `git checkout -b fix/provider-resilience-ps1-ps5 34b0eb8`. Never commit to main.
2. After each step passes its Acceptance line, run `git add -A && git commit -m 'step N'` and go straight to the next step.
3. At the end of each PS group, run the GROUP CHECK shown there. If it's green, keep going.
4. After step 27, run FINAL VERIFICATION once, then push the branch and open a single PR.
5. Never run: git reset (soft or hard), git checkout ., git restore, git clean, git rebase, or any squash. Tyler squashes on merge.

## HOW TO READ THE STEPS

- Line numbers are from base 34b0eb8. Earlier steps shift later lines in the same file, so find each edit by its BEFORE text (quoted exactly from the base) and replace it with the AFTER text.
- "NEW FILE" means create the file with exactly that content.
- Don't refactor, rename or reformat anything outside the quoted blocks.
- PS4 (step 21) is a placeholder. DO NOT IMPLEMENT IT.

==========================================================================================
PS1: PARTIAL ANSWER (a failed seat no longer kills the run)
==========================================================================================

## STEP 1: NEW FILE src/swarm/engine/partialResult.ts

AFTER (new file):

```ts
import type { SwarmContext } from "../context.ts";
import { guardManagerResponse } from "../parser.ts";

/**
 * 'partial' ONLY when the final answer did not come from the manager (the whole manager chain failed and the
 * best analyst output was returned). Seats that failed with no backup are listed in `degraded` but keep 'complete'.
 */
export type SwarmRunStatus = "complete" | "partial";

const DEGRADED_KEY = "__degradedSeats";

/** Record a seat id (agent id, else role) that exhausted every fallback. A seat that recovered via a fallback is never recorded. */
export function recordDegraded(context: SwarmContext, seatId: string): void {
  const ctx = context as any;
  if (!Array.isArray(ctx[DEGRADED_KEY])) ctx[DEGRADED_KEY] = [];
  const id = String(seatId);
  if (!ctx[DEGRADED_KEY].includes(id)) ctx[DEGRADED_KEY].push(id);
}

export function getDegraded(context: SwarmContext): string[] {
  const list = (context as any)[DEGRADED_KEY];
  return Array.isArray(list) ? [...list] : [];
}

export function countAnalystOutputs(allAnalystReports: any[][]): number {
  return (allAnalystReports || []).reduce(
    (n, reps) =>
      n + (reps || []).filter((r) => r !== null && r !== undefined).length,
    0,
  );
}

export interface BestAnalystOutput {
  seatId: string;
  role: string;
  provider: string;
  report: any;
}

/** Picks the richest analyst report (most insights, then anomalies, then summary length). */
export function pickBestAnalystOutput(
  allAnalystReports: any[][],
  analysts: Array<{ role: string; provider: any; id?: string }>,
): BestAnalystOutput | null {
  let best: BestAnalystOutput | null = null;
  let bestScore = -1;
  (allAnalystReports || []).forEach((reps, idx) => {
    for (const rep of reps || []) {
      if (rep === null || rep === undefined) continue;
      const insights = Array.isArray(rep.insights) ? rep.insights.length : 0;
      const anomalies = Array.isArray(rep.anomalies) ? rep.anomalies.length : 0;
      const summaryLen =
        typeof rep.summary === "string" ? rep.summary.length : 0;
      const score =
        insights * 10 + anomalies * 5 + Math.min(summaryLen, 2000) / 100;
      if (score > bestScore) {
        bestScore = score;
        const role = analysts[idx]?.role || `Analyst ${idx + 1}`;
        best = {
          seatId: analysts[idx]?.id || role,
          role,
          provider: String(analysts[idx]?.provider ?? "unknown"),
          report: rep,
        };
      }
    }
  });
  return best;
}

/** Final analysis used when the whole manager chain failed: the best analyst output, flagged partial. */
export function buildPartialFinalAnalysis(
  best: BestAnalystOutput,
  degraded: string[],
): any {
  const rep = best.report || {};
  const insights: string[] = Array.isArray(rep.insights)
    ? rep.insights.map((i: any) => String(i))
    : [];
  const summary =
    [
      typeof rep.summary === "string" ? rep.summary : "",
      insights.length > 0
        ? `Key points: ${insights.slice(0, 8).join(" | ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n") || "Partial result: only analyst output was available.";
  const guarded: any = guardManagerResponse(
    {
      ui_title: `Partial Analysis (from ${best.role})`,
      summary,
      components: [],
    },
    "Partial Analysis",
  );
  return {
    ...guarded,
    partial: true,
    degraded,
    sourceAnalyst: {
      seatId: best.seatId,
      role: best.role,
      provider: best.provider,
    },
    analystReport: rep,
  };
}
```

Acceptance: `npm run lint` passes (the file compiles; nothing imports it yet).

## STEP 2: add status/partial/degraded to the workflow result type, in src/swarm/engine/types.ts:51-52

BEFORE:

```ts
export interface SwarmWorkflowResult {
    workflowId?: string;
```

AFTER:

```ts
export interface SwarmWorkflowResult {
    workflowId?: string;
    /** 'partial' ONLY when the final answer did not come from the manager; absent on legacy paths = 'complete'. */
    status?: 'complete' | 'partial';
    partial?: boolean;
    /** Seat ids that failed with no backup left (a seat that recovered via a fallback is not listed). */
    degraded?: string[];
```

Acceptance: `npm run lint` passes.

## STEP 3: a failed analyst is marked failed and returns null (no throw), in src/swarm/engine/analystExecution.ts

3a. Import, at src/swarm/engine/analystExecution.ts:20-22
BEFORE:

```ts
import { guardAnalystResponse } from "../parser.ts";
import { SwarmTracer } from "../profiler.ts";
import { ANALYST_SYSTEM_INSTRUCTION } from "./constants.ts";
```

AFTER:

```ts
import { guardAnalystResponse } from "../parser.ts";
import { SwarmTracer } from "../profiler.ts";
import { ANALYST_SYSTEM_INSTRUCTION } from "./constants.ts";
import { recordDegraded } from "./partialResult.ts";
```

3b. Outer catch, at src/swarm/engine/analystExecution.ts:244-253
BEFORE:

```ts
        } catch (err: any) {
            const errDetail = err?.stack || err?.message || String(err);
            const durationMs = Date.now() - startTime;
            globalSpecialistProfiler.recordOutcome(analyst.role, {
                success: false,
                durationMs,
                error: errDetail
            });
            console.error(`[Analyst Fatal Error] ${analyst.role} failed:`, errDetail);
            throw err;
```

AFTER:

```ts
        } catch (err: any) {
            const errDetail = err?.stack || err?.message || String(err);
            const durationMs = Date.now() - startTime;
            globalSpecialistProfiler.recordOutcome(analyst.role, {
                success: false,
                durationMs,
                error: errDetail
            });
            console.error(`[Analyst Fatal Error] ${analyst.role} failed:`, errDetail);
            // PS1: the seat exhausted all its fallbacks (no backup left). Mark it degraded and let the run continue.
            recordDegraded(context, (analyst as any).id || analyst.role);
            context.addEvent({
                agentRole: analyst.role,
                action: 'Analyst Failed (seat degraded)',
                modelName: `${analyst.provider} / ${analyst.modelName}`,
                prompt: `Analyst exhausted all fallbacks; continuing without this seat.`,
                error: err?.message || String(err),
                durationMs
            });
            return null;
```

Acceptance: `npm run lint` passes. executeAnalyst now resolves to `null` for a failed seat instead of rejecting.

## STEP 4: never push a null report, in src/swarm/engine/clusterPipeline.ts

(The scheduler path at L295-305 already checks `item.success && item.result`, so leave it alone.)

4a. Speculative path, at src/swarm/engine/clusterPipeline.ts:352-360
BEFORE:

```ts
for (const resData of specResult.results) {
  const chunkIdx = (resData as any)._chunkIndex ?? 0;
  const assignment = routingPlan.assignments.find(
    (asn) => asn.chunkIndex === chunkIdx,
  );
  const assignedAnalyst =
    analysts.find((a) => a.role === assignment?.agentRole) ||
    analysts[chunkIdx % analysts.length];
  const analystIdx = analysts.indexOf(assignedAnalyst);
  if (analystIdx >= 0) {
    allAnalystReports[analystIdx].push(resData);
  }
}
```

AFTER:

```ts
for (const resData of specResult.results) {
  if (resData === null || resData === undefined) continue; // PS1: failed seat
  const chunkIdx = (resData as any)._chunkIndex ?? 0;
  const assignment = routingPlan.assignments.find(
    (asn) => asn.chunkIndex === chunkIdx,
  );
  const assignedAnalyst =
    analysts.find((a) => a.role === assignment?.agentRole) ||
    analysts[chunkIdx % analysts.length];
  const analystIdx = analysts.indexOf(assignedAnalyst);
  if (analystIdx >= 0) {
    allAnalystReports[analystIdx].push(resData);
  }
}
```

4b. Multi-chunk pool/Promise.all path, at src/swarm/engine/clusterPipeline.ts:412-416
BEFORE:

```ts
chunkTasks.forEach((taskItem, index) => {
  if (taskItem.analystIdx >= 0) {
    allAnalystReports[taskItem.analystIdx].push(chunkReports[index]);
  }
});
```

AFTER:

```ts
chunkTasks.forEach((taskItem, index) => {
  const rep = chunkReports[index];
  if (taskItem.analystIdx >= 0 && rep !== null && rep !== undefined) {
    allAnalystReports[taskItem.analystIdx].push(rep);
  }
});
```

4c. Single-chunk path, at src/swarm/engine/clusterPipeline.ts:427-429
BEFORE:

```ts
for (let a = 0; a < analysts.length; a++) {
  allAnalystReports[a].push(chunkReports[a]);
}
```

AFTER:

```ts
for (let a = 0; a < analysts.length; a++) {
  const rep = chunkReports[a];
  if (rep !== null && rep !== undefined) {
    allAnalystReports[a].push(rep);
  }
}
```

Acceptance: `npm run lint` passes. `git grep -n "allAnalystReports\[.*\]\.push" src/swarm/engine/clusterPipeline.ts` shows 4 push sites, and each one is guarded (by item.result or a null check).

## STEP 5: run continues with at least one analyst output; the manager chain failing falls back to the best analyst output; status is in the result. File: src/swarm/engine/index.ts

5a. Import, at src/swarm/engine/index.ts:20
BEFORE:

```ts
import {
  compileSynthesisPrompt,
  executeManagerSynthesis,
} from "./synthesisPipeline.ts";
```

AFTER:

```ts
import {
  compileSynthesisPrompt,
  executeManagerSynthesis,
} from "./synthesisPipeline.ts";
import {
  recordDegraded,
  getDegraded,
  countAnalystOutputs,
  pickBestAnalystOutput,
  buildPartialFinalAnalysis,
  type SwarmRunStatus,
} from "./partialResult.ts";
```

5b. Zero analyst outputs is the only analyst-side hard failure, at src/swarm/engine/index.ts:215-217
BEFORE:

```ts
            });

            let workflowOriginalPromptTokens = clusterResult.workflowOriginalPromptTokens;
```

AFTER:

```ts
            });

            // PS1: only ZERO analyst outputs is fatal (surfaces as swarm_error / HTTP 500).
            // managerFailed = the final answer did NOT come from the manager (the only case that makes the run 'partial').
            let managerFailed = false;
            if (
                countAnalystOutputs(clusterResult.allAnalystReports) === 0 &&
                !(clusterResult.earlyExitTriggered && clusterResult.earlyFinalAnalysis)
            ) {
                const failedSeats = getDegraded(context).join(', ');
                throw new Error(`All analysts failed; no analyst output to compile.${failedSeats ? ' Failed seats: ' + failedSeats : ''}`);
            }

            let workflowOriginalPromptTokens = clusterResult.workflowOriginalPromptTokens;
```

5c. Manager chain exhausted → best analyst output, partial. At src/swarm/engine/index.ts:261-286
BEFORE:

```ts
// Step 5 & 6: Verification vs Standard Synthesis Execution
if (deepAnalysisRequested && (analysts.length > 0 || dedicatedCriticAgent)) {
  const verificationResult = await runDeepAnalysisVerification({
    task,
    rawInput: profilingResult.rawInput,
    effectiveDynamicPrompt: synthesisResult.effectiveDynamicPrompt,
    effectiveCompiledReports: synthesisResult.effectiveCompiledReports,
    effectiveHistoricalContext: synthesisResult.effectiveHistoricalContext,
    managerAgent,
    analysts,
    dedicatedCriticAgent,
    context,
    settings,
  });
  finalAnalysis = verificationResult.finalAnalysis;
  workflowLifecycleResult = verificationResult.lifecycleResult;
} else {
  finalAnalysis = await executeManagerSynthesis(
    managerAgent,
    synthesisResult.effectiveDynamicPrompt,
    context,
    activeVariant,
    bypassCache,
    settings,
  );
}
```

AFTER:

```ts
// Step 5 & 6: Verification vs Standard Synthesis Execution
try {
  if (deepAnalysisRequested && (analysts.length > 0 || dedicatedCriticAgent)) {
    const verificationResult = await runDeepAnalysisVerification({
      task,
      rawInput: profilingResult.rawInput,
      effectiveDynamicPrompt: synthesisResult.effectiveDynamicPrompt,
      effectiveCompiledReports: synthesisResult.effectiveCompiledReports,
      effectiveHistoricalContext: synthesisResult.effectiveHistoricalContext,
      managerAgent,
      analysts,
      dedicatedCriticAgent,
      context,
      settings,
    });
    finalAnalysis = verificationResult.finalAnalysis;
    workflowLifecycleResult = verificationResult.lifecycleResult;
  } else {
    finalAnalysis = await executeManagerSynthesis(
      managerAgent,
      synthesisResult.effectiveDynamicPrompt,
      context,
      activeVariant,
      bypassCache,
      settings,
    );
  }
} catch (managerErr: any) {
  // PS1: the whole manager chain failed. Return the best analyst output as a partial answer.
  // Applies to chat AND morning runs (Architect decision 2026-10-16).
  const best = pickBestAnalystOutput(clusterResult.allAnalystReports, analysts);
  if (!best) {
    throw managerErr;
  }
  managerFailed = true;
  recordDegraded(context, managerAgent.id || "manager");
  finalAnalysis = buildPartialFinalAnalysis(best, getDegraded(context));
  context.addEvent({
    agentRole: "Partial Result Fallback",
    action: "Manager Chain Exhausted",
    modelName: "Local/PartialResult",
    prompt: `Manager chain failed; returning best analyst output from ${best.role} (${best.provider}) as a partial result.`,
    error: managerErr?.message || String(managerErr),
    output: { degraded: getDegraded(context) },
    durationMs: 0,
  });
}
```

5d. status/partial/degraded on the result (workflowId kept), at src/swarm/engine/index.ts:324-327
BEFORE:

```ts
            return {
                workflowId: (context as any).id,
                events: context.events,
                finalAnalysis,
```

AFTER:

```ts
            const degraded = getDegraded(context);
            const status: SwarmRunStatus = managerFailed ? 'partial' : 'complete';

            return {
                workflowId: (context as any).id,
                status,
                partial: managerFailed,
                degraded,
                events: context.events,
                finalAnalysis,
```

(The next base line, `metrics: learningResult.metrics,`, stays as it is.)
Acceptance: `npm run lint` passes. `npm run test:unit` passes with no new failures compared to base (it runs before the PS5 tests exist).

## STEP 6: status and degraded are always present on swarm_complete (SSE) and on /api/swarm/analyze

6a. SSE, at src/swarm/server/streaming.ts:68-75
BEFORE:

```ts
const payload: any = { ...result };
if (result.workflowId) {
  payload.workflowId = String(result.workflowId);
} else {
  delete payload.workflowId;
}

await sendEvent("swarm_complete", payload);
```

AFTER:

```ts
const payload: any = { ...result };
if (result.workflowId) {
  payload.workflowId = String(result.workflowId);
} else {
  delete payload.workflowId;
}
// PS1: partial runs are still swarm_complete, flagged with status:'partial'; degraded = seat ids with no backup left.
payload.status = (result as any).status || "complete";
payload.degraded = Array.isArray((result as any).degraded)
  ? (result as any).degraded
  : [];

await sendEvent("swarm_complete", payload);
```

6b. /analyze, at src/swarm/server/app.ts:555-560
BEFORE:

```ts
            try {
                if (result.workflowId) {
                    result.workflowId = String(result.workflowId);
                } else {
                    delete result.workflowId;
                }
```

AFTER:

```ts
            try {
                if (result.workflowId) {
                    result.workflowId = String(result.workflowId);
                } else {
                    delete result.workflowId;
                }
                // PS1: partial runs return 200 with status:'partial' (and keep workflowId); degraded = seat ids with no backup left.
                result.status = result.status || 'complete';
                result.degraded = Array.isArray(result.degraded) ? result.degraded : [];
```

Acceptance: `npm run lint` passes. The catch in streaming.ts (`swarm_error`) is unchanged, and the engine now only reaches it on zero analyst outputs or on a real crash.

GROUP CHECK (PS1 done): `npm run lint && npm run test:unit`. If it's green, continue straight to the next group without stopping.

==========================================================================================
PS2: PER-PROVIDER LIMITER + CIRCUIT BREAKER (used by every provider call)
==========================================================================================

## STEP 7: NEW FILE src/swarm/providers/limiter.ts

AFTER (new file):

```ts
/**
 * Per-provider limiter + circuit breaker (process memory only).
 * Every provider call made through Agent.run goes through globalProviderLimiter.run().
 * Providers not listed in PROVIDER_LIMITS (simulated, test mocks) pass straight through.
 */

export interface ProviderLimitConfig {
  concurrency: number;
  minSpacingMs: number;
  tokensPerMinute?: number;
}

export const PROVIDER_LIMITS: Record<string, ProviderLimitConfig> = {
  groq: { concurrency: 1, minSpacingMs: 0, tokensPerMinute: 7000 },
  mistral: { concurrency: 1, minSpacingMs: 1100 },
  gemini: { concurrency: 2, minSpacingMs: 0 },
  openrouter: { concurrency: 1, minSpacingMs: 0 },
  // github: not listed. GitHub Models was retired on 2026-07-30 (see the GH group).
};

export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 5 * 60 * 1000;
export const DEAD_MODEL_MS = 24 * 60 * 60 * 1000;
export const MAX_BUDGET_WAIT_MS = 10_000;
export const PROVIDER_CALL_TIMEOUT_MS = 25_000;
export const RETRY_503_BACKOFF_MS = 1_000;
const TOKEN_WINDOW_MS = 60_000;

export class LimiterSkipError extends Error {
  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly reason: string,
  ) {
    super(
      `[LIMITER_SKIP] ${provider}/${model || "default"} unavailable: ${reason}`,
    );
    this.name = "LimiterSkipError";
  }
}

/** chars/4 token estimate (same heuristic the Groq adapter uses). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

export type ProviderFailureKind =
  | "daily_quota"
  | "model_dead"
  | "rate_or_server"
  | "other";

export function classifyProviderError(
  provider: string,
  message: string,
): ProviderFailureKind {
  const msg = message || "";
  const lower = msg.toLowerCase();
  if (provider === "openrouter" && lower.includes("free-models-per-day"))
    return "daily_quota";
  if (
    /\b404\b/.test(msg) ||
    msg.includes("NOT_FOUND") ||
    lower.includes("model_not_found")
  )
    return "model_dead";
  if (
    msg.includes("RATE_LIMIT") ||
    /\b429\b/.test(msg) ||
    msg.includes("SERVER_ERROR") ||
    /\b50[0234]\b/.test(msg)
  ) {
    return "rate_or_server";
  }
  return "other";
}

export function is503(message: string): boolean {
  return (
    (message || "").includes("SERVER_ERROR_503") ||
    /\b503\b/.test(message || "")
  );
}

interface ProviderState {
  active: number;
  waiters: Array<() => void>;
  lastStartAt: number;
  consecutiveFailures: number;
  openUntil: number;
  openReason: string;
  tokenLog: Array<{ at: number; tokens: number }>;
}

export interface LimiterRunRequest {
  provider: string;
  model: string;
  estTokens: number;
}

export class ProviderLimiter {
  private states = new Map<string, ProviderState>();
  private deadModels = new Map<string, number>();

  constructor(
    private readonly limits: Record<
      string,
      ProviderLimitConfig
    > = PROVIDER_LIMITS,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {}

  isManaged(provider: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.limits, provider);
  }

  private state(provider: string): ProviderState {
    let s = this.states.get(provider);
    if (!s) {
      s = {
        active: 0,
        waiters: [],
        lastStartAt: 0,
        consecutiveFailures: 0,
        openUntil: 0,
        openReason: "",
        tokenLog: [],
      };
      this.states.set(provider, s);
    }
    return s;
  }

  /** null = callable now; otherwise why the provider/model is skipped instantly. */
  getSkipReason(provider: string, model?: string): string | null {
    if (!this.isManaged(provider)) return null;
    const t = this.now();
    const s = this.state(provider);
    if (s.openUntil > t) {
      return `circuit open until ${new Date(s.openUntil).toISOString()} (${s.openReason})`;
    }
    if (model) {
      const deadUntil = this.deadModels.get(`${provider}::${model}`);
      if (deadUntil && deadUntil > t) {
        return `model marked dead until ${new Date(deadUntil).toISOString()} (404 model-not-found)`;
      }
    }
    return null;
  }

  isAvailable(provider: string, model?: string): boolean {
    return this.getSkipReason(provider, model) === null;
  }

  recordSuccess(provider: string): void {
    if (!this.isManaged(provider)) return;
    this.state(provider).consecutiveFailures = 0;
  }

  recordFailure(provider: string, model: string, message: string): void {
    if (!this.isManaged(provider)) return;
    const s = this.state(provider);
    const t = this.now();
    const kind = classifyProviderError(provider, message);
    if (kind === "daily_quota") {
      s.openUntil = nextUtcMidnight(t);
      s.openReason = "openrouter free-models-per-day quota exhausted";
      s.consecutiveFailures = 0;
    } else if (kind === "model_dead") {
      if (model)
        this.deadModels.set(`${provider}::${model}`, t + DEAD_MODEL_MS);
    } else if (kind === "rate_or_server") {
      s.consecutiveFailures += 1;
      if (s.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
        s.openUntil = t + BREAKER_OPEN_MS;
        s.openReason = `${s.consecutiveFailures} consecutive 429/5xx`;
        s.consecutiveFailures = 0;
      }
    }
    // 'other' (timeouts, 400s, parse errors) leaves the breaker untouched.
  }

  private tokensUsed(s: ProviderState, t: number): number {
    s.tokenLog = s.tokenLog.filter((e) => t - e.at < TOKEN_WINDOW_MS);
    return s.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
  }

  /** ms until estTokens fits the per-minute budget (0 = fits now, Infinity = can never fit). */
  budgetWaitMs(provider: string, estTokens: number): number {
    const limit = this.limits[provider]?.tokensPerMinute;
    if (!limit) return 0;
    if (estTokens > limit) return Infinity;
    const t = this.now();
    const s = this.state(provider);
    const used = this.tokensUsed(s, t);
    if (used + estTokens <= limit) return 0;
    const mustFree = used + estTokens - limit;
    let freed = 0;
    for (const e of s.tokenLog) {
      freed += e.tokens;
      if (freed >= mustFree) return Math.max(0, e.at + TOKEN_WINDOW_MS - t);
    }
    return Infinity;
  }

  private async acquireSlot(provider: string): Promise<void> {
    const s = this.state(provider);
    const cfg = this.limits[provider];
    while (s.active >= cfg.concurrency) {
      await new Promise<void>((resolve) => s.waiters.push(resolve));
    }
    s.active += 1;
    const spacingWait = s.lastStartAt + cfg.minSpacingMs - this.now();
    if (cfg.minSpacingMs > 0 && spacingWait > 0) {
      await this.sleep(spacingWait);
    }
    s.lastStartAt = this.now();
  }

  private releaseSlot(provider: string): void {
    const s = this.state(provider);
    s.active = Math.max(0, s.active - 1);
    const next = s.waiters.shift();
    if (next) next();
  }

  async run<T>(req: LimiterRunRequest, fn: () => Promise<T>): Promise<T> {
    const { provider, model, estTokens } = req;
    if (!this.isManaged(provider)) return fn();

    const skip = this.getSkipReason(provider, model);
    if (skip) throw new LimiterSkipError(provider, model, skip);

    await this.acquireSlot(provider);
    try {
      const wait = this.budgetWaitMs(provider, estTokens);
      if (wait > MAX_BUDGET_WAIT_MS) {
        throw new LimiterSkipError(
          provider,
          model,
          `token budget needs ${Number.isFinite(wait) ? Math.ceil(wait) + "ms" : "more than a full minute"} of waiting (max ${MAX_BUDGET_WAIT_MS}ms); skipping to next fallback`,
        );
      }
      if (wait > 0) await this.sleep(wait);
      if (this.limits[provider].tokensPerMinute) {
        this.state(provider).tokenLog.push({
          at: this.now(),
          tokens: estTokens,
        });
      }

      let retried503 = false;
      while (true) {
        try {
          const out = await fn();
          this.recordSuccess(provider);
          return out;
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (!retried503 && is503(msg)) {
            retried503 = true; // exactly one backoff retry, 503 only
            await this.sleep(RETRY_503_BACKOFF_MS);
            continue;
          }
          this.recordFailure(provider, model, msg);
          throw err;
        }
      }
    } finally {
      this.releaseSlot(provider);
    }
  }

  /** Clears all breaker/budget state (tests). */
  reset(): void {
    this.states.clear();
    this.deadModels.clear();
  }
}

export const globalProviderLimiter = new ProviderLimiter();
```

Acceptance: `npm run lint` passes.

## STEP 8: route every Agent provider call through the limiter, with a 25s timeout and instant skip of open providers/models. File: src/swarm/agent.ts

8a. Import, at src/swarm/agent.ts:7
BEFORE:

```ts
import {
  globalLoadBalancer,
  type AdaptiveLoadBalancer,
} from "./loadBalancer.ts";
```

AFTER:

```ts
import {
  globalLoadBalancer,
  type AdaptiveLoadBalancer,
} from "./loadBalancer.ts";
import {
  globalProviderLimiter,
  estimateTokens,
  PROVIDER_CALL_TIMEOUT_MS,
} from "./providers/limiter.ts";
import { groqPromptCharCap } from "./providers/groq.ts";
```

8b. 25s per-call timeout, at src/swarm/agent.ts:83
BEFORE:

```ts
const timeoutMs = config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes
```

AFTER:

```ts
const timeoutMs = config?.timeoutMs || PROVIDER_CALL_TIMEOUT_MS; // 25s per call (PS2), then next fallback
```

8c. Wrap the adapter call, at src/swarm/agent.ts:150-164
BEFORE:

```ts
                    } else {
                        const targetModel = currentTarget.modelName || (currentTarget.provider === this.provider ? this.modelName : (DEFAULT_PROVIDER_MODELS[currentTarget.provider] || this.modelName));
                        textOutput = await lb.executeWithTelemetry(
                            currentTarget.provider,
                            () => adapter.call({
                                modelName: targetModel,
                                prompt,
                                systemInstruction: this.systemInstruction,
                                apiKey: currentTarget.apiKey,
                                aiClient: currentTarget.aiClient || this.aiClient,
                                config: effectiveConfig,
                                timeoutMs,
                                role: this.role
                            })
                        );
```

AFTER:

```ts
                    } else {
                        const targetModel = currentTarget.modelName || (currentTarget.provider === this.provider ? this.modelName : (DEFAULT_PROVIDER_MODELS[currentTarget.provider] || this.modelName));
                        // Budget estimate (chars/4) uses what the adapter will actually send: Groq caps the prompt by mode (chat 18k / morning 6k).
                        const promptCharCap = currentTarget.provider === 'groq' ? groqPromptCharCap(effectiveConfig.groqMode) : prompt.length;
                        const estChars = Math.min(prompt.length, promptCharCap) + (this.systemInstruction?.length || 0);
                        textOutput = await globalProviderLimiter.run(
                            { provider: String(currentTarget.provider), model: targetModel, estTokens: estimateTokens(estChars) },
                            () => lb.executeWithTelemetry(
                                currentTarget.provider,
                                () => adapter.call({
                                    modelName: targetModel,
                                    prompt,
                                    systemInstruction: this.systemInstruction,
                                    apiKey: currentTarget.apiKey,
                                    aiClient: currentTarget.aiClient || this.aiClient,
                                    config: effectiveConfig,
                                    timeoutMs,
                                    role: this.role
                                })
                            )
                        );
```

(The next base line, `globalPayloadCache.set(cacheFingerprint, textOutput);`, stays as it is.)

8d. A limiter skip (open circuit, dead model, budget) never retries the same target, at src/swarm/agent.ts:304-308
BEFORE:

```ts
const hasNextProvider = targetIdx < targetChain.length - 1;

if (isFatal && !hasNextProvider) {
  break; // Fatal error (like model not found), don't waste time retrying
}
```

AFTER:

```ts
const hasNextProvider = targetIdx < targetChain.length - 1;
const isLimiterSkip = errMsg.includes("[LIMITER_SKIP]");

if ((isFatal || isLimiterSkip) && !hasNextProvider) {
  break; // Fatal error (like model not found) or limiter skip: retrying the same target cannot help
}
```

(LIMITER_SKIP messages contain "unavailable", so the existing `isFailoverEligible` already sends them on to the next fallback right away.)
Acceptance: `npm run lint` passes. `npx vitest run src/swarm/failover-timeout.test.ts` passes (its test providers aren't in PROVIDER_LIMITS, so they pass straight through).

## STEP 9: Groq mode budget (explicit 'chat' | 'morning'), in src/swarm/providers/groq.ts

9a. Import, at src/swarm/providers/groq.ts:1
BEFORE:

```ts
import {
  cleanToken,
  buildStandardMessages,
  parseStandardResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from "./adapter.ts";
```

AFTER:

```ts
import {
  cleanToken,
  buildStandardMessages,
  parseStandardResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from "./adapter.ts";
import { LimiterSkipError } from "./limiter.ts";

/**
 * PS2 Groq budget modes (passed explicitly by callers via config.groqMode):
 * - 'chat':    prompt capped at 18,000 chars; max_tokens = min(2000, 7000 - ceil(promptChars/4)); < 800 => skip Groq (next fallback).
 * - 'morning': unchanged legacy behavior (6,000-char cap + computeGroqMaxTokens 6k-total clamp).
 * A call with no groqMode (critic, verification, other callers) keeps the legacy/morning behavior.
 */
export type GroqMode = "chat" | "morning";
export const GROQ_CHAT_PROMPT_CHARS = 18_000;
export const GROQ_MORNING_PROMPT_CHARS = 6_000;
export const GROQ_CHAT_MAX_TOKENS = 2_000;
export const GROQ_CHAT_TPM_BUDGET = 7_000;
export const GROQ_CHAT_MIN_TOKENS = 800;

export function groqPromptCharCap(mode?: unknown): number {
  return mode === "chat" ? GROQ_CHAT_PROMPT_CHARS : GROQ_MORNING_PROMPT_CHARS;
}

/** Chat mode: min(2000, 7000 - ceil(promptChars/4)). promptChars = system instruction + capped prompt. */
export function computeGroqChatMaxTokens(promptChars: number): number {
  return Math.min(
    GROQ_CHAT_MAX_TOKENS,
    GROQ_CHAT_TPM_BUDGET - Math.ceil(Math.max(0, promptChars) / 4),
  );
}
```

9b. Use the mode in GroqAdapter.call, at src/swarm/providers/groq.ts:47-55
BEFORE:

```ts
// Cap prompt string at 6,000 characters (preserving core task and baselines)
const promptText = capGroqPrompt(options.prompt, 6000);
const optionsWithCappedPrompt = { ...options, prompt: promptText };
const messages = buildStandardMessages(optionsWithCappedPrompt);

// Estimate prompt tokens (~4 chars per token)
const totalPromptLength =
  (options.systemInstruction?.length || 0) + promptText.length;
const estimatedPromptTokens = Math.ceil(totalPromptLength / 4);
const maxTokens = computeGroqMaxTokens(options, estimatedPromptTokens);
```

AFTER:

```ts
// PS2: explicit mode. Chat caps at 18k chars; morning (and callers with no mode) keep the 6k cap.
const mode: GroqMode = options.config?.groqMode === "chat" ? "chat" : "morning";
const promptText = capGroqPrompt(options.prompt, groqPromptCharCap(mode));
const optionsWithCappedPrompt = { ...options, prompt: promptText };
const messages = buildStandardMessages(optionsWithCappedPrompt);

// Estimate prompt tokens (~4 chars per token)
const totalPromptLength =
  (options.systemInstruction?.length || 0) + promptText.length;
const estimatedPromptTokens = Math.ceil(totalPromptLength / 4);
let maxTokens: number;
if (mode === "chat") {
  maxTokens = computeGroqChatMaxTokens(totalPromptLength);
  if (maxTokens < GROQ_CHAT_MIN_TOKENS) {
    // No harder truncation: skip Groq so Agent.run moves to the next fallback immediately.
    throw new LimiterSkipError(
      "groq",
      options.modelName,
      `chat max_tokens budget ${maxTokens} < ${GROQ_CHAT_MIN_TOKENS}; skipping Groq`,
    );
  }
} else {
  maxTokens = computeGroqMaxTokens(options, estimatedPromptTokens);
}
```

(capGroqPrompt at L3-15 and computeGroqMaxTokens at L17-36 are unchanged, so morning values stay identical to base.)
Acceptance: `npm run lint` passes. `npx vitest run src/swarm/providers/groq.test.ts` passes unchanged: its calls pass no groqMode, so they take the morning/legacy path.

## STEP 10: pass groqMode explicitly at both call sites ('morning' for morning_judge runs, else 'chat')

10a. Analysts, at src/swarm/engine/analystExecution.ts:112-116
BEFORE:

```ts
rawOutput = await analyst.run(effectiveAnalystPrompt, context, {
  responseMimeType: "application/json",
  bypassCache,
  ...activeVariant?.parameters,
});
```

AFTER:

```ts
rawOutput = await analyst.run(effectiveAnalystPrompt, context, {
  responseMimeType: "application/json",
  bypassCache,
  groqMode:
    (settings as any)?.responseSchema === "morning_judge" ? "morning" : "chat",
  ...activeVariant?.parameters,
});
```

10b. Manager, at src/swarm/engine/synthesisPipeline.ts:213-218
BEFORE:

```ts
const parsedManagerOutput = await managerAgent.run(
  effectiveDynamicPrompt,
  context,
  {
    responseMimeType: "application/json",
    zodSchema,
    bypassCache,
    ...activeVariant?.parameters,
  },
);
```

AFTER:

```ts
const parsedManagerOutput = await managerAgent.run(
  effectiveDynamicPrompt,
  context,
  {
    responseMimeType: "application/json",
    zodSchema,
    bypassCache,
    groqMode: isMorningJudge ? "morning" : "chat",
    ...activeVariant?.parameters,
  },
);
```

Acceptance: `npm run lint` passes (AgentRunConfig has `[key: string]: any`, so there are no type changes).

## STEP 11: start analysts ~1.5s apart, in src/swarm/engine/analystExecution.ts:66-69

BEFORE:

```ts
    return async function executeAnalyst(analyst: Agent, chunk: string, chunkIdx: number) {
        const nodeKey = (analyst as any).id || analyst.role;
        const capacitySlot = globalNodeCapacityManager.tryAcquireSlot(nodeKey) ||
                             globalNodeCapacityManager.tryAcquireSlot(analyst.provider);
```

AFTER:

```ts
    // PS2: stagger analyst seat starts ~1.5s apart (first call per seat; later chunks of a seat are not re-delayed).
    // Override with settings.analystStaggerMs; 0 under vitest so existing tests stay fast.
    const staggerMs: number = typeof (settings as any)?.analystStaggerMs === 'number'
        ? (settings as any).analystStaggerMs
        : (typeof process !== 'undefined' && process.env?.VITEST ? 0 : 1500);
    const seatOrder = new Map<string, number>();

    return async function executeAnalyst(analyst: Agent, chunk: string, chunkIdx: number) {
        const seatKey = (analyst as any).id || analyst.role;
        if (!seatOrder.has(seatKey)) seatOrder.set(seatKey, seatOrder.size);
        const startDelay = (seatOrder.get(seatKey) ?? 0) * staggerMs;
        if (startDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, startDelay));
        }

        const nodeKey = (analyst as any).id || analyst.role;
        const capacitySlot = globalNodeCapacityManager.tryAcquireSlot(nodeKey) ||
                             globalNodeCapacityManager.tryAcquireSlot(analyst.provider);
```

Acceptance: `npm run lint` passes and `npm run test:unit` passes.

GROUP CHECK (PS2 done): `npm run lint && npm run test:unit && npx vitest run src/swarm/failover-timeout.test.ts src/swarm/providers/groq.test.ts`. If it's green, continue straight to the next group without stopping.

==========================================================================================
GH: GITHUB MODELS IS RETIRED: DISABLE THE PROVIDER AND DROP ITS DEFAULTS (before PS3)
==========================================================================================
Why: GitHub Models was fully retired on Jul 30, 2026. The inference API, the catalog and BYOK are gone, so every call to
models.github.ai or models.inference.ai.azure.com fails (Scout, runbook "2026-10-16 1:30 PM CT"). These steps stop the swarm from
choosing, defaulting to, probing or borrowing github. The `Provider` type (types.ts:3 KNOWN_PROVIDERS), the GitHubAdapter export
(src/swarm/index.ts:17) and the `githubToken` settings field stay as they are, so the package API and stored settings don't break.
A stale seat that is still configured with provider 'github' fails instantly and fails over (step 12).

## STEP 12: GitHubAdapter fails fast with a "retired" error and never calls the network, in src/swarm/providers/github.ts

(Scout cites github.ts:30, the `fetch('https://models.github.ai/inference/chat/completions', {` line. Verified at 34b0eb8. The guard below sits in front of it, so L30 can no longer be reached. The rest of the adapter stays as it is.
registry.ts:20 `this.register(new GitHubAdapter());` was verified at 34b0eb8 and is deliberately kept. If it were unregistered, a stale github seat would hit `Unsupported AI Provider: 'github'`, which Agent.run (agent.ts:269-302) treats as neither fatal nor failover-eligible, so it would sleep 2s and retry before failing over. A registered adapter that throws the retired error is fatal, so it fails over immediately with no retry.)

12a. Constants, at src/swarm/providers/github.ts:3
BEFORE:

```ts
export class GitHubAdapter implements ProviderAdapter {
```

AFTER:

```ts
/** GitHub Models was retired on 2026-07-30 (inference API, catalog and BYOK removed for everyone). */
export const GITHUB_MODELS_RETIRED = true;
export const GITHUB_MODELS_RETIRED_MESSAGE =
    'GitHub Models was retired on 2026-07-30: the provider is disabled and its inference endpoint does not exist anymore. Pick another provider.';

export class GitHubAdapter implements ProviderAdapter {
```

12b. Fail fast before any key check or fetch, at src/swarm/providers/github.ts:6-10
BEFORE:

```ts
    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing GitHub Models Personal Access Token.');
        }
```

AFTER:

```ts
    async call(options: ProviderCallOptions): Promise<string> {
        // Retired provider: never hit the network. The message contains "does not exist", so Agent.run treats it
        // as fatal and moves straight to the next fallback with no retry.
        if (GITHUB_MODELS_RETIRED) {
            throw new Error(GITHUB_MODELS_RETIRED_MESSAGE);
        }
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing GitHub Models Personal Access Token.');
        }
```

Acceptance: `npm run lint` passes.

## STEP 13: drop the github default model, in src/swarm/agent.ts:16-18

BEFORE:

```ts
    mistral: 'mistral-small-latest',
    github: 'gpt-4o-mini'
};
```

AFTER:

```ts
    mistral: 'mistral-small-latest'
    // github removed: GitHub Models was retired on 2026-07-30.
};
```

(The only change inside DEFAULT_PROVIDER_MODELS in this branch. The other four entries stay as they are; PS4 decides those.)
Acceptance: `npm run lint` passes.

## STEP 14: the router no longer recommends a github model (router.ts:158-160), and router.test.ts:140-143 is updated to match

14a. Router, at src/swarm/router.ts:158-161
BEFORE:

```ts
            case 'github':
                // gpt-4o-mini has higher RPM allowance on GitHub Models free tier
                return 'gpt-4o-mini';
            default:
```

AFTER:

```ts
            // 'github' removed: GitHub Models was retired on 2026-07-30, so it falls through to the default.
            default:
```

14b. Existing test that hard-codes the github model, at src/swarm/router.test.ts:140-143
BEFORE:

```ts
it("should return gpt-4o-mini for github", () => {
  expect(ModelRouter.getRecommendedModel("github", "instant")).toBe(
    "gpt-4o-mini",
  );
  expect(ModelRouter.getRecommendedModel("github", "simple")).toBe(
    "gpt-4o-mini",
  );
});
```

AFTER:

```ts
it("no longer special-cases github (GitHub Models retired 2026-07-30): it falls back like an unknown provider", () => {
  expect(ModelRouter.getRecommendedModel("github", "instant")).toBe(
    "gemini-2.5-flash",
  );
  expect(ModelRouter.getRecommendedModel("github", "simple")).toBe(
    "gemini-2.5-flash",
  );
});
```

Acceptance: `npm run lint` passes and `npx vitest run src/swarm/router.test.ts` passes.

## STEP 15: /api/swarm/models no longer keys, probes or lists github (Scout: modelsProvider.ts:119,197), in src/swarm/server/modelsProvider.ts

(L119 is the deprecated `models.inference.ai.azure.com/chat/completions` probe URL, and L197 is the `models.inference.ai.azure.com/models` list call. L70 (`keyFor`) is removed too, so github never gets a key and is never probed. With all three gone, `fetchProviderModels('github', …)` returns [] with no network call, and `warnUnknownConfiguredModels` skips github.)

15a. keyFor, at src/swarm/server/modelsProvider.ts:69-70
BEFORE:

```ts
        case 'openrouter': return env.OPENROUTER_API_KEY;
        case 'github': return env.GITHUB_TOKEN;
```

AFTER:

```ts
        case 'openrouter': return env.OPENROUTER_API_KEY;
```

15b. probeUrl, at src/swarm/server/modelsProvider.ts:117-119
BEFORE:

```ts
            return 'https://openrouter.ai/api/v1/chat/completions';
        case 'github':
            return 'https://models.inference.ai.azure.com/chat/completions';
```

AFTER:

```ts
return "https://openrouter.ai/api/v1/chat/completions";
```

15c. listProviderModels, at src/swarm/server/modelsProvider.ts:194-204
BEFORE:

```ts
        case 'github': {
            const apiKey = clientKey || env.GITHUB_TOKEN;
            if (!apiKey) return [];
            const res = await fetch('https://models.inference.ai.azure.com/models', { headers: { Authorization: `Bearer ${apiKey}` } });
            if (!res.ok) throw new Error('Failed to fetch GitHub models');
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.data || []);
            return list.map((m: any) => ({ id: m.name, name: m.friendly_name || m.name, free: true }));
        }
        default:
            return [];
```

AFTER:

```ts
        // 'github' removed: GitHub Models was retired on 2026-07-30 (falls through to []).
        default:
            return [];
```

Acceptance: `npm run lint` passes and `npx vitest run src/swarm/server/modelsProvider.warn.test.ts` passes.

## STEP 16: github is no longer a fallback provider (fallback order: gemini, openrouter, groq, mistral), in src/swarm/engine/agentResolution.ts:11

BEFORE:

```ts
const ALL_PROVIDERS: Provider[] = [
  "gemini",
  "openrouter",
  "groq",
  "github",
  "mistral",
];
```

AFTER:

```ts
// 'github' removed: GitHub Models was retired on 2026-07-30, so it can never be a fallback or a pool provider.
const ALL_PROVIDERS: Provider[] = ["gemini", "openrouter", "groq", "mistral"];
```

Acceptance: `npm run lint` passes and `npm run test:unit` passes.

## STEP 17: NEW FILE src/swarm/providers/github.retired.test.ts

AFTER (new file):

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { GitHubAdapter, GITHUB_MODELS_RETIRED_MESSAGE } from "./github.ts";
import { ProviderRegistry } from "./registry.ts";
import { Agent, DEFAULT_PROVIDER_MODELS } from "../agent.ts";
import { SwarmContext } from "../context.ts";
import { ModelRouter } from "../router.ts";
import {
  fetchProviderModels,
  warnUnknownConfiguredModels,
} from "../server/modelsProvider.ts";
import { resolveSwarmAgents } from "../engine/agentResolution.ts";

describe("GitHub Models retired (2026-07-30)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("GitHubAdapter fails fast with the retired error and never calls the network", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    await expect(
      new GitHubAdapter().call({
        modelName: "gpt-4o-mini",
        prompt: "hello",
        apiKey: "ghp_test_token",
        role: "Analyst",
      } as any),
    ).rejects.toThrow(/retired/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(GITHUB_MODELS_RETIRED_MESSAGE).toMatch(/does not exist/);
  });

  it("a stale github seat fails over to its fallback immediately (fatal, no retry)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    ProviderRegistry.register({
      providerName: "gh-retired-backup-mock",
      async call() {
        return JSON.stringify({ source: "backup" });
      },
    } as any);
    const agent = new Agent(
      "Analyst",
      "gpt-4o-mini",
      "github" as any,
      "ghp_test_token",
      undefined,
      [
        {
          provider: "gh-retired-backup-mock" as any,
          apiKey: "k",
          modelName: "backup-model",
        },
      ],
    );
    const started = Date.now();
    const result = await agent.run("prompt", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("backup");
    expect(Date.now() - started).toBeLessThan(1500); // no 2s retry backoff
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no github default model and no github router recommendation", () => {
    expect(DEFAULT_PROVIDER_MODELS.github).toBeUndefined();
    expect(ModelRouter.getRecommendedModel("github", "instant")).not.toBe(
      "gpt-4o-mini",
    );
  });

  it("/api/swarm/models never keys, lists or probes github", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    expect(
      await fetchProviderModels("github", "ghp_test_token", {
        GITHUB_TOKEN: "ghp_test_token",
      }),
    ).toEqual([]);
    expect(
      await warnUnknownConfiguredModels(
        { github: ["gpt-4o-mini"] },
        { GITHUB_TOKEN: "ghp_test_token" },
      ),
    ).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("github never joins the analyst or manager fallbacks, even with GITHUB_TOKEN set and a github seat", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_key");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const resolved = resolveSwarmAgents(
      {
        agents: [
          {
            id: "manager",
            role: "Manager Node",
            provider: "ps-ok-mock",
            apiKey: "k-mgr",
            model: "mock-mgr",
          },
          {
            id: "a1",
            role: "Analyst",
            provider: "ps-ok-mock",
            apiKey: "k-a1",
            model: "mock-a1",
          },
          {
            id: "g1",
            role: "Groq Seat",
            provider: "groq",
            model: "openai/gpt-oss-20b",
          },
          {
            id: "gh",
            role: "Stale GitHub Seat",
            provider: "github",
            model: "gpt-4o-mini",
          },
        ],
      } as any,
      undefined,
    );
    const providers = [
      ...resolved.managerAgent.getFallbacks(),
      ...resolved.analysts.flatMap((a: any) => a.getFallbacks()),
    ].map((f) => String(f.provider));
    expect(providers).toContain("groq");
    expect(providers).not.toContain("github");
  });
});
```

Acceptance: `npx vitest run src/swarm/providers/github.retired.test.ts` passes (5 tests).

GROUP CHECK (GH done): `npm run lint && npm run test:unit`. If it's green, continue straight to the next group without stopping.

==========================================================================================
PS3: SERVER-SIDE MANAGER_CHAIN + GLOBAL ANALYST FALLBACK POOL (depends on PS2)
==========================================================================================

## STEP 18: NEW FILE src/swarm/engine/managerChain.ts

AFTER (new file):

```ts
import type { GoogleGenAI } from "@google/genai";
import type {
  ProviderCredential,
  Provider,
  AgentConfig,
  SwarmEngineSettings,
} from "../types.ts";
import { resolveProvider } from "./utils.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";
import { DEFAULT_PROVIDER_MODELS } from "../agent.ts";

/**
 * Ordered server-side manager fallback chain (PS3).
 * Free tiers only (Tyler, 2026-10-16). github is not here: GitHub Models was retired on 2026-07-30.
 * PROVISIONAL models: to be finalized by PS4 (Code Auditor provider probe). Do not change them in this branch.
 */
export const MANAGER_CHAIN: ReadonlyArray<{
  provider: Provider;
  model: string;
}> = [
  { provider: "gemini" as Provider, model: "gemini-2.5-flash" },
  { provider: "gemini" as Provider, model: "gemini-2.5-flash-lite" },
  { provider: "mistral" as Provider, model: "mistral-small-latest" },
  { provider: "groq" as Provider, model: "openai/gpt-oss-120b" },
];

/**
 * MANAGER_CHAIN entries that have a server (Render env) key and a closed circuit/live model.
 * `exclude` drops the manager's own provider+model (an empty model drops every entry for that provider).
 */
export function buildManagerChain(
  defaultAi?: GoogleGenAI,
  exclude?: { provider: string; model?: string },
): ProviderCredential[] {
  const out: ProviderCredential[] = [];
  for (const entry of MANAGER_CHAIN) {
    if (
      exclude &&
      entry.provider === exclude.provider &&
      (!exclude.model || exclude.model === entry.model)
    )
      continue;
    if (!globalProviderLimiter.isAvailable(entry.provider, entry.model))
      continue;
    // Server env keys only (empty settings): the chain never depends on a user-supplied key.
    const { key, client } = resolveProvider(
      entry.provider,
      {} as SwarmEngineSettings,
      defaultAi,
    );
    if (!key) continue;
    out.push({
      provider: entry.provider,
      modelName: entry.model,
      apiKey: key,
      aiClient: client,
    });
  }
  return out;
}

/**
 * Global analyst fallback pool: every provider with a key (user or env), using that provider's seat model
 * when one is configured, else DEFAULT_PROVIDER_MODELS. Open circuits / dead models are left out.
 * seatModelsOnly (morning runs): only providers that already have a seat model in this run, i.e. the pre-PS3
 * behavior. Morning never borrows from the global pool, so the cron can't burn chat quota.
 */
export function buildAnalystPool(
  providers: Provider[],
  settings: SwarmEngineSettings | undefined,
  rawAgents: AgentConfig[],
  defaultAi?: GoogleGenAI,
  options: { seatModelsOnly?: boolean } = {},
): ProviderCredential[] {
  const pool: ProviderCredential[] = [];
  for (const p of providers) {
    const { key, client } = resolveProvider(
      p,
      settings as SwarmEngineSettings,
      defaultAi,
    );
    if (!key) continue;
    const seat = rawAgents.find(
      (a: AgentConfig) =>
        a.provider === p && a.model && a.model.trim().length > 0,
    );
    if (options.seatModelsOnly && !seat) continue;
    const model = (seat?.model || DEFAULT_PROVIDER_MODELS[p] || "").trim();
    if (!model) continue;
    if (!globalProviderLimiter.isAvailable(p, model)) continue;
    pool.push({ provider: p, apiKey: key, modelName: model, aiClient: client });
  }
  return pool;
}

/** Concatenate fallback lists, keeping the first occurrence of each provider+model. */
export function mergeFallbacks(
  ...lists: ProviderCredential[][]
): ProviderCredential[] {
  const seen = new Set<string>();
  const out: ProviderCredential[] = [];
  for (const list of lists) {
    for (const f of list) {
      const k = `${f.provider}::${f.modelName || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}
```

Acceptance: `npm run lint` passes. (agentResolution.ts:3-4 imports `ProviderCredential, Provider, AgentConfig` and `SwarmEngineSettings` from '../types.ts', so the import above matches.)

## STEP 19: the manager keeps MANAGER_CHAIN order (the load balancer must not reorder it), in src/swarm/agent.ts

19a. Field, at src/swarm/agent.ts:36-37
BEFORE:

```ts
    private fallbacks: ProviderCredential[] = [];
    private loadBalancer?: AdaptiveLoadBalancer;
```

AFTER:

```ts
    private fallbacks: ProviderCredential[] = [];
    private loadBalancer?: AdaptiveLoadBalancer;
    /** PS3: when true, fallbacks run in the given order (manager chain) instead of load-balancer score order. */
    public preserveFallbackOrder = false;
```

19b. Sorting, at src/swarm/agent.ts:86-89
BEFORE:

```ts
const candidateFallbacks = config?.fallbackProviders || this.fallbacks;
const sortedFallbacks =
  candidateFallbacks.length > 1
    ? [...candidateFallbacks].sort(
        (a, b) => lb.calculateScore(b.provider) - lb.calculateScore(a.provider),
      )
    : candidateFallbacks;
```

AFTER:

```ts
const candidateFallbacks = config?.fallbackProviders || this.fallbacks;
const sortedFallbacks =
  candidateFallbacks.length > 1 && !this.preserveFallbackOrder
    ? [...candidateFallbacks].sort(
        (a, b) => lb.calculateScore(b.provider) - lb.calculateScore(a.provider),
      )
    : candidateFallbacks;
```

Acceptance: `npm run lint` passes.

## STEP 20: wire the chain and the pool into agent resolution, in src/swarm/engine/agentResolution.ts

(The runbook cites "agentResolution.ts:85-105". At base 34b0eb8 the fallback loop is L84-101 and the manager fallbacks are L106-108.)

20a. Import, at src/swarm/engine/agentResolution.ts:8
BEFORE:

```ts
import {
  sanitizeApiKey,
  validateProviderKey,
  resolveProvider,
} from "./utils.ts";
```

AFTER:

```ts
import {
  sanitizeApiKey,
  validateProviderKey,
  resolveProvider,
} from "./utils.ts";
import {
  buildManagerChain,
  buildAnalystPool,
  mergeFallbacks,
} from "./managerChain.ts";
```

20b. Global analyst pool (replaces "only providers that already have a seat model"), at src/swarm/engine/agentResolution.ts:84-101
BEFORE:

```ts
const availableFallbacks: ProviderCredential[] = [];
if (!settings?.disableFallback) {
  for (const p of ALL_PROVIDERS) {
    const { key, client } = resolveProvider(p, settings, defaultAi);
    if (key) {
      const userConfiguredAgent = rawAgents.find(
        (a: AgentConfig) => a.provider === p && a.model,
      );
      const fallbackModel = userConfiguredAgent?.model || "";
      if (fallbackModel && fallbackModel.trim().length > 0) {
        availableFallbacks.push({
          provider: p,
          apiKey: key,
          modelName: fallbackModel,
          aiClient: client,
        });
      }
    }
  }
}
```

AFTER:

```ts
// PS3: global analyst fallback pool. Any keyed, healthy provider can cover a failed seat,
// not only providers that already have a seat in this run.
// Morning runs (morning_judge) do NOT borrow from the global pool: seat-model providers only (pre-PS3 behavior).
const isMorningRun = (settings as any)?.responseSchema === "morning_judge";
const availableFallbacks: ProviderCredential[] = settings?.disableFallback
  ? []
  : buildAnalystPool(ALL_PROVIDERS, settings, rawAgents, defaultAi, {
      seatModelsOnly: isMorningRun,
    });
```

20c. Manager fallbacks = MANAGER_CHAIN (server keys, open circuits skipped) then the pool, at src/swarm/engine/agentResolution.ts:106-108
BEFORE:

```ts
const managerModel = managerConfig.model || "";
const managerFallbacks = availableFallbacks.filter(
  (f) => f.provider !== managerConfig.provider,
);
const managerAgent = new Agent(
  "Manager Node",
  managerModel,
  managerConfig.provider,
  finalMKey,
  mClient,
  managerFallbacks,
);
```

AFTER:

```ts
const managerModel = managerConfig.model || "";
const managerFallbacks = settings?.disableFallback
  ? []
  : mergeFallbacks(
      buildManagerChain(defaultAi, {
        provider: managerConfig.provider,
        model: managerModel,
      }),
      availableFallbacks.filter((f) => f.provider !== managerConfig.provider),
    );
const managerAgent = new Agent(
  "Manager Node",
  managerModel,
  managerConfig.provider,
  finalMKey,
  mClient,
  managerFallbacks,
);
managerAgent.preserveFallbackOrder = true;
```

(The analyst `aFallbacks` at L119-121 and the critic `cFallbacks` at L138 already filter `availableFallbacks` by provider, so chat runs now draw on the global pool without further edits, and morning runs keep seat-model fallbacks only. `disableFallback`/`strictProvider` seats still get []. The manager keeps MANAGER_CHAIN in its configured order via `preserveFallbackOrder` (step 19); open circuits and dead models are skipped at build time (buildManagerChain) and again at call time (limiter skip in Agent.run).)
Acceptance: `npm run lint` passes and `npm run test:unit` passes.

GROUP CHECK (PS3 done): `npm run lint && npm run test:unit`. If it's green, continue straight to the next group without stopping.

==========================================================================================
PS4: MODEL DEFAULTS / PROBE ENDPOINT: PLACEHOLDER ONLY
==========================================================================================

## STEP 21: DO NOT IMPLEMENT: pending Code Auditor provider probe

No code change in this branch. Apart from removing the github entry in step 13, don't touch DEFAULT_PROVIDER_MODELS (src/swarm/agent.ts:12-18). Also leave the MANAGER_CHAIN models (step 18), critic defaults and any probe endpoint alone. Those come in a separate prompt after the Code Auditor's provider probe results.
Don't create an empty commit for this step. Skip it and go on to step 22; mention "Step 21: placeholder, skipped" in the final PR description.
Acceptance: inside `DEFAULT_PROVIDER_MODELS`, `git diff 34b0eb8 -- src/swarm/agent.ts` changes only the github removal from step 13 (the mistral line loses its trailing comma).

==========================================================================================
PS5: TESTS
==========================================================================================

## STEP 22: NEW FILE src/swarm/providers/limiter.test.ts

AFTER (new file):

```ts
import { describe, it, expect } from "vitest";
import {
  ProviderLimiter,
  LimiterSkipError,
  nextUtcMidnight,
  BREAKER_OPEN_MS,
  DEAD_MODEL_MS,
  RETRY_503_BACKOFF_MS,
} from "./limiter.ts";

function makeClock(start: number) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe("ProviderLimiter (PS2)", () => {
  it("groq: defers a call that fits within ~10s and skips one that would wait longer", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 15, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);
    const ok = async () => "ok";

    await limiter.run(
      { provider: "groq", model: "openai/gpt-oss-120b", estTokens: 5000 },
      ok,
    );

    // 5000 + 3000 > 7000 and the window frees in ~60s: skip, don't wait.
    await expect(
      limiter.run(
        { provider: "groq", model: "openai/gpt-oss-120b", estTokens: 3000 },
        ok,
      ),
    ).rejects.toBeInstanceOf(LimiterSkipError);

    // 55s later the first entry frees in ~5s, so the call waits (deferred) and then runs.
    clock.advance(55_000);
    const out = await limiter.run(
      { provider: "groq", model: "openai/gpt-oss-120b", estTokens: 3000 },
      ok,
    );
    expect(out).toBe("ok");
    expect(clock.sleeps.some((ms) => ms > 0 && ms <= 10_000)).toBe(true);
  });

  it("groq: runs one call at a time (concurrency 1)", async () => {
    const limiter = new ProviderLimiter();
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return "done";
    };
    await Promise.all([
      limiter.run({ provider: "groq", model: "m", estTokens: 10 }, job),
      limiter.run({ provider: "groq", model: "m", estTokens: 10 }, job),
    ]);
    expect(maxActive).toBe(1);
  });

  it("openrouter: free-models-per-day 429 opens the circuit until 00:00 UTC", async () => {
    const start = Date.UTC(2026, 9, 16, 18, 30, 0);
    const clock = makeClock(start);
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);

    await expect(
      limiter.run(
        { provider: "openrouter", model: "x:free", estTokens: 10 },
        async () => {
          throw new Error(
            "[RATE_LIMIT_429] OpenRouter rate limit / credit exhaustion: Rate limit exceeded: free-models-per-day",
          );
        },
      ),
    ).rejects.toThrow(/free-models-per-day/);

    expect(limiter.isAvailable("openrouter")).toBe(false);
    await expect(
      limiter.run(
        { provider: "openrouter", model: "other:free", estTokens: 10 },
        async () => "never",
      ),
    ).rejects.toBeInstanceOf(LimiterSkipError);

    const midnight = nextUtcMidnight(start);
    expect(midnight).toBe(Date.UTC(2026, 9, 17, 0, 0, 0));
    clock.advance(midnight - start - 1);
    expect(limiter.isAvailable("openrouter")).toBe(false);
    clock.advance(2);
    expect(limiter.isAvailable("openrouter")).toBe(true);
  });

  it("404 model-not-found marks only that model dead for 24h", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);

    await expect(
      limiter.run(
        { provider: "gemini", model: "gone-model", estTokens: 10 },
        async () => {
          throw new Error("Gemini API Error (404): NOT_FOUND model not found");
        },
      ),
    ).rejects.toThrow(/404/);

    expect(limiter.isAvailable("gemini", "gone-model")).toBe(false);
    expect(limiter.isAvailable("gemini", "live-model")).toBe(true);
    expect(limiter.isAvailable("gemini")).toBe(true);

    clock.advance(DEAD_MODEL_MS + 1);
    expect(limiter.isAvailable("gemini", "gone-model")).toBe(true);
  });

  it("3 consecutive 429/5xx open the provider for 5 minutes; a success resets the count", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);
    const fail429 = async () => {
      throw new Error("[RATE_LIMIT_429] Mistral API rate limit exceeded");
    };

    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    await limiter.run(
      { provider: "mistral", model: "m", estTokens: 1 },
      async () => "ok",
    ); // resets the count
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    expect(limiter.isAvailable("mistral")).toBe(true);
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    expect(limiter.isAvailable("mistral")).toBe(false);

    clock.advance(BREAKER_OPEN_MS + 1);
    expect(limiter.isAvailable("mistral")).toBe(true);
  });

  it("retries a 503 exactly once after a backoff, and never retries a 429", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);

    let calls503 = 0;
    const out = await limiter.run(
      { provider: "gemini", model: "g", estTokens: 1 },
      async () => {
        calls503++;
        if (calls503 === 1)
          throw new Error("[SERVER_ERROR_503] service unavailable");
        return "recovered";
      },
    );
    expect(out).toBe("recovered");
    expect(calls503).toBe(2);
    expect(clock.sleeps).toContain(RETRY_503_BACKOFF_MS);

    let calls429 = 0;
    await expect(
      limiter.run(
        { provider: "gemini", model: "g", estTokens: 1 },
        async () => {
          calls429++;
          throw new Error("[RATE_LIMIT_429] quota");
        },
      ),
    ).rejects.toThrow();
    expect(calls429).toBe(1);
  });

  it("passes unmanaged providers (mocks/simulated) straight through", async () => {
    const limiter = new ProviderLimiter();
    for (let i = 0; i < 5; i++) {
      await expect(
        limiter.run(
          { provider: "custom-mock", model: "m", estTokens: 1 },
          async () => {
            throw new Error("[RATE_LIMIT_429] x");
          },
        ),
      ).rejects.toThrow();
    }
    expect(limiter.isAvailable("custom-mock")).toBe(true);
  });
});
```

Acceptance: `npx vitest run src/swarm/providers/limiter.test.ts` passes (7 tests).

## STEP 23: NEW FILE src/swarm/engine/managerChain.test.ts

AFTER (new file):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildManagerChain,
  buildAnalystPool,
  mergeFallbacks,
  MANAGER_CHAIN,
} from "./managerChain.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";
import { DEFAULT_PROVIDER_MODELS } from "../agent.ts";
import { resolveSwarmAgents } from "./agentResolution.ts";

const ids = (list: Array<{ provider: any; modelName?: string }>) =>
  list.map((c) => `${c.provider}:${c.modelName}`);

describe("MANAGER_CHAIN + analyst pool (PS3)", () => {
  beforeEach(() => {
    globalProviderLimiter.reset();
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token"); // set on purpose: github must never appear (retired 2026-07-30)
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("MISTRAL_API_KEY", "mistral-test-key");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_key");
    vi.stubEnv("OPENROUTER_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalProviderLimiter.reset();
  });

  it("MANAGER_CHAIN is gemini-2.5-flash, gemini-2.5-flash-lite, mistral, groq (no github)", () => {
    expect(MANAGER_CHAIN.map((e) => `${e.provider}:${e.model}`)).toEqual([
      "gemini:gemini-2.5-flash",
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    expect(MANAGER_CHAIN.some((e) => String(e.provider) === "github")).toBe(
      false,
    );
  });

  it("keeps MANAGER_CHAIN order and only uses entries with a server key", () => {
    expect(ids(buildManagerChain())).toEqual([
      "gemini:gemini-2.5-flash",
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(buildManagerChain().map((c) => c.provider)).toEqual([
      "mistral",
      "groq",
    ]);
  });

  it("skips providers whose circuit is open and models marked dead", () => {
    // A dead model only removes that model: flash-lite stays.
    globalProviderLimiter.recordFailure(
      "gemini",
      "gemini-2.5-flash",
      "Gemini API Error (404): NOT_FOUND model",
    );
    expect(ids(buildManagerChain())).toEqual([
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    // An open circuit removes every entry for that provider.
    for (let i = 0; i < 3; i++)
      globalProviderLimiter.recordFailure(
        "gemini",
        "gemini-2.5-flash-lite",
        "[RATE_LIMIT_429] x",
      );
    globalProviderLimiter.recordFailure(
      "mistral",
      "mistral-small-latest",
      "Mistral API Error (404): model not found",
    );
    expect(buildManagerChain().map((c) => c.provider)).toEqual(["groq"]);
  });

  it("excludes the manager's own provider+model", () => {
    const chain = buildManagerChain(undefined, {
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(ids(chain)).toEqual([
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    const noMistral = buildManagerChain(undefined, { provider: "mistral" });
    expect(noMistral.map((c) => c.provider)).toEqual([
      "gemini",
      "gemini",
      "groq",
    ]);
  });

  it("analyst pool covers every keyed provider, using the default model when no seat uses it", () => {
    const pool = buildAnalystPool(
      ["gemini", "openrouter", "groq", "mistral"] as any,
      {} as any,
      [
        {
          id: "a1",
          role: "Analyst",
          provider: "groq",
          model: "openai/gpt-oss-20b",
        } as any,
      ],
    );
    expect(pool.map((p) => p.provider)).toEqual(["gemini", "groq", "mistral"]);
    expect(pool.find((p) => p.provider === "groq")?.modelName).toBe(
      "openai/gpt-oss-20b",
    );
    expect(pool.find((p) => p.provider === "gemini")?.modelName).toBe(
      DEFAULT_PROVIDER_MODELS.gemini,
    );
    expect(pool.find((p) => p.provider === "mistral")?.modelName).toBe(
      DEFAULT_PROVIDER_MODELS.mistral,
    );
  });

  it("morning runs never borrow from the global analyst pool (chat runs do, and never from github)", () => {
    const agents = [
      {
        id: "manager",
        role: "Manager Node",
        provider: "ps-ok-mock",
        apiKey: "k-mgr",
        model: "mock-mgr",
      },
      {
        id: "a1",
        role: "Analyst",
        provider: "ps-ok-mock",
        apiKey: "k-a1",
        model: "mock-a1",
      },
    ];
    const morning = resolveSwarmAgents(
      { responseSchema: "morning_judge", agents } as any,
      undefined,
    );
    expect(morning.analysts[0].getFallbacks()).toEqual([]);

    const chat = resolveSwarmAgents({ agents } as any, undefined);
    expect(chat.analysts[0].getFallbacks().map((f) => f.provider)).toEqual([
      "gemini",
      "groq",
      "mistral",
    ]);
    expect(
      chat.managerAgent.getFallbacks().map((f) => String(f.provider)),
    ).not.toContain("github");

    // Morning still keeps seat-model fallbacks (pre-PS3 behavior): a keyed provider that has a seat in the run.
    const morningWithSeat = resolveSwarmAgents(
      {
        responseSchema: "morning_judge",
        agents: [
          ...agents,
          {
            id: "g1",
            role: "Groq Seat",
            provider: "groq",
            model: "openai/gpt-oss-20b",
          },
        ],
      } as any,
      undefined,
    );
    expect(
      morningWithSeat.analysts[0]
        .getFallbacks()
        .map((f) => `${f.provider}:${f.modelName}`),
    ).toEqual(["groq:openai/gpt-oss-20b"]);
  });

  it("mergeFallbacks de-duplicates provider+model, keeping the first", () => {
    const merged = mergeFallbacks(
      [{ provider: "gemini", modelName: "a", apiKey: "k" } as any],
      [
        { provider: "gemini", modelName: "a", apiKey: "k2" } as any,
        { provider: "groq", modelName: "b", apiKey: "k3" } as any,
      ],
    );
    expect(
      merged.map((m) => `${m.provider}:${m.modelName}:${m.apiKey}`),
    ).toEqual(["gemini:a:k", "groq:b:k3"]);
  });
});
```

Acceptance: `npx vitest run src/swarm/engine/managerChain.test.ts` passes (7 tests). If sanitizeApiKey rejects these test key formats, change only the stub values so they pass sanitizeApiKey; don't change production code.

## STEP 24: NEW FILE src/swarm/engine/partialResult.test.ts (end-to-end through executeSwarmWorkflow: degraded vs recovered vs partial, plus morning)

AFTER (new file):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeSwarmWorkflow } from "./index.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { GroqAdapter } from "../providers/groq.ts";
import {
  globalTokenBudgetManager,
  globalSpecialistProfiler,
  globalNodeCapacityManager,
} from "../loadBalancer.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";

const goodReport = (tag: string) =>
  JSON.stringify({
    insights: [`${tag} insight one`, `${tag} insight two`],
    anomalies: [],
    summary: `${tag} summary`,
    ui_title: `${tag} title`,
    components: [],
  });

let groqPoolCalls = 0;

const run = (appId: string, agents: any[], extra: Record<string, any> = {}) =>
  executeSwarmWorkflow({
    task: `PS1 test ${appId}: evaluate the matchup`,
    data: `short payload for a single chunk (${appId})`,
    forceFullSwarm: true,
    bypassCache: true,
    settings: { appId, agents, ...extra },
  } as any);

const MANAGER_OK = {
  id: "manager",
  role: "Manager Node",
  provider: "ps-ok-mock",
  apiKey: "k-mgr",
  model: "mock-mgr",
};
const MANAGER_DEAD = {
  id: "manager",
  role: "Manager Node",
  provider: "ps-dead-mock",
  apiKey: "k-mgr",
  model: "mock-mgr",
};
const GOOD = {
  id: "good",
  role: "Good Analyst",
  provider: "ps-ok-mock",
  apiKey: "k-good",
  model: "mock-good",
};
const BAD = {
  id: "bad",
  role: "Dead Analyst",
  provider: "ps-dead-mock",
  apiKey: "k-bad",
  model: "mock-bad",
};

describe("PS1 partial / degraded semantics", () => {
  beforeEach(() => {
    globalTokenBudgetManager.reset();
    globalSpecialistProfiler.reset();
    globalNodeCapacityManager.reset();
    globalProviderLimiter.reset();
    groqPoolCalls = 0;

    // Only Groq has a server key, so the global pool / manager chain = [groq] and no real network is reachable.
    // (github is no longer a provider in the chain or the pool, so GITHUB_TOKEN doesn't matter here.)
    vi.stubEnv("GROQ_API_KEY", "gsk_test_key");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    ProviderRegistry.register({
      providerName: "ps-ok-mock",
      async call(options: any) {
        return goodReport(options.role || "ok");
      },
    } as any);
    // 400 is treated as fatal by Agent.run, so these fail instantly with no backoff wait.
    ProviderRegistry.register({
      providerName: "ps-dead-mock",
      async call() {
        throw new Error("Mock API Error (400): provider down everywhere");
      },
    } as any);
    // Stand-in for the pooled Groq fallback (counts every borrow).
    ProviderRegistry.register({
      providerName: "groq",
      async call(options: any) {
        groqPoolCalls++;
        return goodReport(`groq-fallback ${options.role || ""}`);
      },
    } as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    ProviderRegistry.register(new GroqAdapter());
    globalProviderLimiter.reset();
  });

  it("a seat that fails with no backup is degraded, but the run stays complete", async () => {
    const result: any = await run("ps1-degraded", [MANAGER_OK, GOOD, BAD], {
      disableFallback: true,
    });
    expect(result.status).toBe("complete");
    expect(result.partial).toBe(false);
    expect(result.degraded).toEqual(["bad"]);
    expect(result.finalAnalysis?.partial).not.toBe(true);
    expect(result.workflowId).toBeTruthy();
  });

  it("a seat that recovers through a fallback is neither partial nor degraded", async () => {
    const result: any = await run("ps1-recovered", [MANAGER_OK, GOOD, BAD]);
    expect(groqPoolCalls).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe("complete");
    expect(result.partial).toBe(false);
    expect(result.degraded).toEqual([]);
    expect(result.workflowId).toBeTruthy();
  });

  it("an all-dead manager chain returns the best analyst output with partial:true", async () => {
    const result: any = await run("ps1-manager-dead", [MANAGER_DEAD, GOOD], {
      disableFallback: true,
    });
    expect(result.status).toBe("partial");
    expect(result.partial).toBe(true);
    expect(result.finalAnalysis.partial).toBe(true);
    expect(result.finalAnalysis.sourceAnalyst.seatId).toBe("good");
    expect(result.degraded).toEqual(["manager"]);
    expect(result.workflowId).toBeTruthy();
  });

  it("zero analyst outputs is still a hard failure (swarm_error path)", async () => {
    await expect(
      run("ps1-all-dead", [MANAGER_OK, BAD], { disableFallback: true }),
    ).rejects.toThrow(/All analysts failed/);
  });

  it("morning runs never pull from the global analyst pool", async () => {
    const result: any = await run(
      "ps1-morning-no-pool",
      [MANAGER_OK, GOOD, BAD],
      { responseSchema: "morning_judge" },
    );
    expect(groqPoolCalls).toBe(0);
    expect(result.degraded).toEqual(["bad"]);
    expect(result.status).toBe("complete");
  });

  it("morning runs keep the PS1 partial fallback when the manager chain is dead", async () => {
    const result: any = await run("ps1-morning-partial", [MANAGER_DEAD, GOOD], {
      responseSchema: "morning_judge",
      disableFallback: true,
    });
    expect(result.status).toBe("partial");
    expect(result.partial).toBe(true);
    expect(result.finalAnalysis.partial).toBe(true);
  });
});
```

Acceptance: `npx vitest run src/swarm/engine/partialResult.test.ts` passes (6 tests). Leave `enableDeepAnalysis` unset. To make it deterministic, adjust only the test, never production code.

## STEP 25: /analyze and SSE both carry status, degraded and workflowId (extend the existing round-trip test), in src/swarm/server/app.test.ts

25a. /analyze, at src/swarm/server/app.test.ts:175-178
BEFORE:

```ts
const analyzeData = await resAnalyze.json();
const returnedWorkflowId = analyzeData.workflowId;
expect(typeof returnedWorkflowId).toBe("string");
expect(returnedWorkflowId.length).toBeGreaterThan(0);
```

AFTER:

```ts
const analyzeData = await resAnalyze.json();
const returnedWorkflowId = analyzeData.workflowId;
expect(typeof returnedWorkflowId).toBe("string");
expect(returnedWorkflowId.length).toBeGreaterThan(0);
expect(["complete", "partial"]).toContain(analyzeData.status);
expect(Array.isArray(analyzeData.degraded)).toBe(true);
```

25b. SSE swarm_complete, at src/swarm/server/app.test.ts:217-220
BEFORE:

```ts
const streamWorkflowId = streamData.workflowId;

expect(typeof streamWorkflowId).toBe("string");
expect(streamWorkflowId.length).toBeGreaterThan(0);
```

AFTER:

```ts
const streamWorkflowId = streamData.workflowId;

expect(typeof streamWorkflowId).toBe("string");
expect(streamWorkflowId.length).toBeGreaterThan(0);
expect(["complete", "partial"]).toContain(streamData.status);
expect(Array.isArray(streamData.degraded)).toBe(true);
```

Acceptance: `npx vitest run src/swarm/server/app.test.ts` passes.

## STEP 26: NEW FILE src/swarm/providers/groq.mode.test.ts (Groq chat vs morning budget)

AFTER (new file):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GroqAdapter,
  computeGroqMaxTokens,
  computeGroqChatMaxTokens,
  GROQ_CHAT_PROMPT_CHARS,
} from "./groq.ts";
import { LimiterSkipError, globalProviderLimiter } from "./limiter.ts";
import { ProviderRegistry } from "./registry.ts";
import { Agent } from "../agent.ts";
import { SwarmContext } from "../context.ts";

describe("Groq mode budget (PS2)", () => {
  const originalFetch = globalThis.fetch;
  let bodies: any[] = [];

  beforeEach(() => {
    globalProviderLimiter.reset();
    bodies = [];
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"status":"ok"}' } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
        };
      }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalProviderLimiter.reset();
  });

  it("chat: an 18k-char prompt is capped at 18,000 chars and gets max_tokens <= 2000", async () => {
    await new GroqAdapter().call({
      modelName: "openai/gpt-oss-120b",
      prompt: "x".repeat(25_000),
      apiKey: "gsk-test",
      role: "Data Analyst",
      config: { groqMode: "chat" },
    });
    const userMsg = bodies[0].messages.find((m: any) => m.role === "user");
    expect(userMsg.content.length).toBe(GROQ_CHAT_PROMPT_CHARS);
    expect(bodies[0].max_tokens).toBeLessThanOrEqual(2000);
    expect(bodies[0].max_tokens).toBe(computeGroqChatMaxTokens(18_000)); // min(2000, 7000 - 4500) = 2000
    expect(computeGroqChatMaxTokens(24_000)).toBe(1000); // 7000 - 6000
  });

  it("chat: a prompt that leaves < 800 max_tokens skips Groq without calling the API", async () => {
    await expect(
      new GroqAdapter().call({
        modelName: "openai/gpt-oss-120b",
        prompt: "x".repeat(18_000),
        systemInstruction: "S".repeat(8_000), // 26,000 chars -> 6,500 tokens -> 500 < 800
        apiKey: "gsk-test",
        role: "Data Analyst",
        config: { groqMode: "chat" },
      }),
    ).rejects.toBeInstanceOf(LimiterSkipError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("chat: Agent.run moves on to the next fallback when Groq is skipped for budget", async () => {
    ProviderRegistry.register({
      providerName: "groq-budget-backup-mock",
      async call() {
        return JSON.stringify({ source: "backup" });
      },
    } as any);
    const agent = new Agent(
      "Data Analyst",
      "openai/gpt-oss-120b",
      "groq" as any,
      "gsk-test",
      undefined,
      [
        {
          provider: "groq-budget-backup-mock" as any,
          apiKey: "k",
          modelName: "backup-model",
        },
      ],
    );
    agent.setSystemInstruction("S".repeat(8_000));
    const result = await agent.run("x".repeat(18_000), new SwarmContext(), {
      responseMimeType: "application/json",
      groqMode: "chat",
      bypassCache: true,
    });
    expect(result.source).toBe("backup");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("morning (and no mode): unchanged legacy 6k cap and computeGroqMaxTokens values", async () => {
    const managerOpts = {
      modelName: "openai/gpt-oss-120b",
      prompt: "x".repeat(30_000),
      apiKey: "gsk-test",
      role: "Manager Node",
      config: { groqMode: "morning", maxTokens: 5000 },
    };
    await new GroqAdapter().call(managerOpts);
    await new GroqAdapter().call({
      ...managerOpts,
      config: { maxTokens: 5000 },
    }); // no mode = legacy
    for (const body of bodies) {
      const userMsg = body.messages.find((m: any) => m.role === "user");
      expect(userMsg.content.length).toBe(6000);
      expect(body.max_tokens).toBe(4500); // 6000 - ceil(6000/4)
      expect(body.max_tokens).toBe(
        computeGroqMaxTokens(managerOpts as any, 1500),
      );
    }

    await new GroqAdapter().call({
      modelName: "openai/gpt-oss-120b",
      prompt: "Analyze market steam",
      apiKey: "gsk-test",
      role: "Market Proposer",
      config: { groqMode: "morning" },
    });
    expect(bodies[2].max_tokens).toBe(1024);
  });
});
```

Acceptance: `npx vitest run src/swarm/providers/groq.mode.test.ts` passes (4 tests).

## STEP 27: NEW FILE src/swarm/agent.fallbackOrder.test.ts (manager chain order is kept; open circuits and dead models are still skipped)

AFTER (new file):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Agent } from "./agent.ts";
import { SwarmContext } from "./context.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { GeminiAdapter } from "./providers/gemini.ts";
import { MistralAdapter } from "./providers/mistral.ts";
import { GroqAdapter } from "./providers/groq.ts";
import { globalProviderLimiter } from "./providers/limiter.ts";

const calls: string[] = [];

function registerMock(name: string, ok: boolean) {
  ProviderRegistry.register({
    providerName: name,
    async call() {
      calls.push(name);
      if (!ok) throw new Error("Mock API Error (400): primary down");
      return JSON.stringify({ source: name });
    },
  } as any);
}

// Load balancer stub that scores 'order-b-mock' highest, so a re-sort would put it first.
const lbFavoringB: any = {
  calculateScore: (p: string) => (p === "order-b-mock" ? 100 : 0),
  executeWithTelemetry: (_p: any, fn: () => Promise<any>) => fn(),
};

describe("Agent fallback order (PS3 preserveFallbackOrder)", () => {
  beforeEach(() => {
    calls.length = 0;
    globalProviderLimiter.reset();
    registerMock("order-dead-mock", false);
    registerMock("order-a-mock", true);
    registerMock("order-b-mock", true);
  });

  afterEach(() => {
    ProviderRegistry.register(new GeminiAdapter());
    ProviderRegistry.register(new MistralAdapter());
    ProviderRegistry.register(new GroqAdapter());
    globalProviderLimiter.reset();
  });

  const fallbacks = [
    { provider: "order-a-mock" as any, apiKey: "k", modelName: "a" },
    { provider: "order-b-mock" as any, apiKey: "k", modelName: "b" },
  ];

  it("keeps the configured order when preserveFallbackOrder is true (no load-balancer re-sort)", async () => {
    const agent = new Agent(
      "Manager Node",
      "m",
      "order-dead-mock" as any,
      "k",
      undefined,
      fallbacks,
      lbFavoringB,
    );
    agent.preserveFallbackOrder = true;
    const result = await agent.run("prompt", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("order-a-mock");
    expect(calls).toEqual(["order-dead-mock", "order-a-mock"]);
  });

  it("still re-sorts by load-balancer score when the flag is off (analyst default)", async () => {
    const agent = new Agent(
      "Analyst",
      "m",
      "order-dead-mock" as any,
      "k",
      undefined,
      fallbacks,
      lbFavoringB,
    );
    const result = await agent.run("prompt 2", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("order-b-mock");
  });

  it("in configured order, skips an open circuit and a dead model without calling them", async () => {
    registerMock("gemini", true);
    registerMock("mistral", true);
    registerMock("groq", true);
    for (let i = 0; i < 3; i++)
      globalProviderLimiter.recordFailure(
        "gemini",
        "gemini-2.5-flash",
        "[RATE_LIMIT_429] x",
      );
    globalProviderLimiter.recordFailure(
      "mistral",
      "dead-model",
      "Mistral API Error (404): model not found",
    );

    // Same shape as MANAGER_CHAIN: gemini (circuit open, both models), mistral (dead model), then groq.
    const agent = new Agent(
      "Manager Node",
      "m",
      "order-dead-mock" as any,
      "k",
      undefined,
      [
        {
          provider: "gemini" as any,
          apiKey: "k",
          modelName: "gemini-2.5-flash",
        },
        {
          provider: "gemini" as any,
          apiKey: "k",
          modelName: "gemini-2.5-flash-lite",
        },
        { provider: "mistral" as any, apiKey: "k", modelName: "dead-model" },
        {
          provider: "groq" as any,
          apiKey: "k",
          modelName: "openai/gpt-oss-120b",
        },
      ],
      lbFavoringB,
    );
    agent.preserveFallbackOrder = true;
    const result = await agent.run("prompt 3", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("groq");
    expect(calls).toEqual(["order-dead-mock", "groq"]);
  });
});
```

Acceptance: `npx vitest run src/swarm/agent.fallbackOrder.test.ts` passes (3 tests). (The afterEach restores the real Gemini, Mistral and Groq adapters registered at registry.ts:16-19. The test no longer uses GitHubAdapter.)

GROUP CHECK (PS5 done): `npx vitest run src/swarm/providers/limiter.test.ts src/swarm/engine/managerChain.test.ts src/swarm/engine/partialResult.test.ts src/swarm/server/app.test.ts src/swarm/providers/groq.mode.test.ts src/swarm/agent.fallbackOrder.test.ts`. If it's green, continue straight to the next group without stopping.

==========================================================================================
FINAL VERIFICATION (run once, after step 27)
==========================================================================================
npm ci
npm run lint
npm run test:unit
npm run test:simulation
npm run build
npx vitest run src/swarm/providers/limiter.test.ts src/swarm/engine/managerChain.test.ts src/swarm/engine/partialResult.test.ts src/swarm/server/app.test.ts src/swarm/providers/groq.mode.test.ts src/swarm/agent.fallbackOrder.test.ts src/swarm/failover-timeout.test.ts src/swarm/providers/groq.test.ts src/swarm/providers/github.retired.test.ts src/swarm/router.test.ts src/swarm/server/modelsProvider.warn.test.ts

If a pre-existing test fails only because breaker/budget state from an earlier test leaks (global limiter, process memory), add `beforeEach(() => globalProviderLimiter.reset())` (import from the providers/limiter.ts path relative to that test) in that test file. Don't weaken limiter behavior to make tests pass.

Sanity greps (expected results):
git grep -n "capGroqPrompt(options.prompt, 6000)" -- src → no matches
git grep -n "groqMode" -- src/swarm/engine → 2 matches (analystExecution.ts, synthesisPipeline.ts)
git grep -n "seatModelsOnly: isMorningRun" -- src/swarm/engine → 1 match (agentResolution.ts)
git grep -n "globalProviderLimiter.run(" -- src/swarm/agent.ts → 1 match
git grep -n "MANAGER_CHAIN" -- src/swarm/engine/managerChain.ts → matches
git grep -n "status || 'complete'" -- src/swarm/server → 2 matches (streaming.ts, app.ts)
git grep -n "'github'" -- src/swarm/engine/managerChain.ts src/swarm/engine/agentResolution.ts src/swarm/providers/limiter.ts → only the "'github' removed" comment in agentResolution.ts
git grep -n "gpt-4o-mini\|models.inference.ai.azure.com" -- src/swarm/agent.ts src/swarm/router.ts src/swarm/server/modelsProvider.ts → no matches
git grep -n "GITHUB_MODELS_RETIRED" -- src/swarm/providers/github.ts → 4 matching lines (2 declarations, the if, the throw)

Expected `git diff --stat 34b0eb8` file list (24 files; nothing else):
src/swarm/agent.ts
src/swarm/agent.fallbackOrder.test.ts (new)
src/swarm/engine/agentResolution.ts
src/swarm/engine/analystExecution.ts
src/swarm/engine/clusterPipeline.ts
src/swarm/engine/index.ts
src/swarm/engine/managerChain.ts (new)
src/swarm/engine/managerChain.test.ts (new)
src/swarm/engine/partialResult.ts (new)
src/swarm/engine/partialResult.test.ts (new)
src/swarm/engine/synthesisPipeline.ts
src/swarm/engine/types.ts
src/swarm/providers/github.ts
src/swarm/providers/github.retired.test.ts (new)
src/swarm/providers/groq.ts
src/swarm/providers/groq.mode.test.ts (new)
src/swarm/providers/limiter.ts (new)
src/swarm/providers/limiter.test.ts (new)
src/swarm/server/app.ts
src/swarm/server/app.test.ts
src/swarm/server/modelsProvider.ts
src/swarm/server/streaming.ts
src/swarm/router.ts
src/swarm/router.test.ts
The only allowed extra file is a pre-existing test file that needed the limiter reset line above. Name it in the final PR description.

Last check before pushing: `git log --oneline 34b0eb8..HEAD` shows 26 commits (step 1 to step 27, no step 21), and `git diff --stat 34b0eb8` lists the files above. Then push the branch and open ONE PR; its "Files changed" tab must not be empty.

## DEPLOY NOTES

- Render redeploys from main after Tyler merges (squash). No new env vars are required. MANAGER_CHAIN only uses providers whose Render env key is set (GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY). At least GEMINI_API_KEY or MISTRAL_API_KEY should be set, or the manager falls back to Groq or the best analyst output.
- GITHUB_TOKEN is no longer used by the chain, the fallback pool or /api/swarm/models. If it's set on Render it's harmless; removing it is Tyler's call (agents don't change Render env vars). app.ts:410,510 and morning/index.ts:198 still pass it through as `githubToken`, which is intentionally unchanged.
- Optional knob: settings.analystStaggerMs (defaults to 1500ms in prod, 0 under vitest).
- Response contract: `status` is 'partial' only when the manager chain failed and the answer is the best analyst output (finalAnalysis.partial = true). `degraded` (string[] of seat ids, e.g. ["bad", "manager"]) lists seats that failed with no backup; it is always present on swarm_complete and /analyze (possibly []).
- Morning cron (morning_judge): partial fallback + breakers apply; there is no global-pool borrowing (seat-model fallbacks only); Groq runs in 'morning' mode with the unchanged 6k budget.
- Groq chat: 18k-char cap, max_tokens = min(2000, 7000 - ceil(promptChars/4)); below 800 Groq is skipped to the next fallback.
- Breaker/budget state is in process memory, so it resets on every Render deploy or restart. That's expected.
- No DB migrations, no Supabase changes, no frontend changes. Clients that ignore `status` keep working: partial runs are still `swarm_complete` / HTTP 200, and `workflowId` is unchanged.
- PS4 (model defaults / probe endpoint) is NOT in this branch. The MANAGER_CHAIN models are provisional until that lands.
