IDE RUN-THROUGH: The Perfect Swarm, morning cache bypass (URGENT) + startup benchmark quota + Groq-first morning + nemotron-3-ultra alias

Base: main 2d6e4a7 "Merge pull request #92 from tbreauxai/fix/morning-snapshots-feedback" (14:45 CT). Fetched 2026-10-16 2:54 PM CT;
main had NOT moved from what Manager said (2d6e4a7), re-checked at assembly.
This file applies cleanly BOTH on that main as is AND on main + the four open swarm files (dedupe, round 2, Phase F, round 3 v2),
in any order (round 3 still needs round 2 first, as before). Anchors are the same text on both; line numbers below are from the
full end state unless main's are given too. Find every edit by its BEFORE text.
Runbook: the runbook has NO entry for the benchmark quota / Groq-morning / nemotron work. This file is written from Manager's request
(2:54 PM CT) plus Navigator's 2:55 and 2:57 PM CT steering. Gap noted below.
Branch: create a NEW branch from up-to-date main, e.g. `fix/morning-cache-bypass-quota`.
Size: 13 steps = 13 commits, 5 groups. 12 files change (6 new, 6 edited) + the smoke empty commit.
BQ-0 step 1 shared startup smoke (already on main → empty commit)
MC steps 2-4 URGENT: morning judge bypasses every cache (+ test that fails without the fix)
BQ steps 5-7 startup benchmark gate: off by default, no gemma-4-31b, 429 never retried
MG steps 8-11 morning runs: judge on Groq, no OpenRouter seat or fallback; AI Lab keeps OpenRouter
NM steps 12-13 OpenRouter adapter aliases the dead nemotron-3-ultra :free id to nemotron-3-super :free

URGENT (ship before the 10 PM CT morning run): group MC comes first, right after the smoke step.

- Live (Debugger/Code Auditor): 36 of the 37 swarm judgments written Oct 15-16 are copies of ONE verdict, mlb-401908025 TB@CLE
  ("Home field advantage in the dome ... boosting Cleveland's win chances"), across NHL, NBA, NFL and NCAAF.
- Root cause (/workspace/rootcause_swarm_identical_judgments_2026-10-16.md): the morning call (src/swarm/morning/index.ts, executeWorkflowFn
  at main:180 / end state ~203) passes no bypassCache, so the engine's lexical semantic cache (threshold 0.80, task text only, 60 min TTL)
  returned the TB@CLE verdict for every other game. Seed: the forced run that finished 04:15:31 UTC (11:15 PM CT Oct 15). judgePrompt
  silently remapped the foreign likelyWinner, so the copies passed validation.
- Fix (step 2): `bypassCache: true` on that call. The engine already honors it (engine/index.ts:111 → cachingPipeline.ts:136 / :227 payload
  cache / :311 semantic cache; agent.ts:144). Step 3 adds a warn-only log when a judge names neither team (no behavior change). Step 4's
  test runs two different games through the real engine in one run and asserts two judge calls and two different verdicts; without step 2
  it fails ("expected [Array(1)] to have a length of 2 but got 1" and "expected undefined to be true"). Verified on both bases.
- Optional hardening (semantic-cache scoping/threshold, cachingPipeline.ts:97) is NOT included: it changes AI Lab caching and isn't safe
  tonight. Listed under GAPS. No re-judge and no data step in this file (TYLER STEPS).

BENCHMARK GATE (group BQ): env flag, OFF by default (SWARM_STARTUP_BENCHMARK=1|true|yes|on enables it).

- Why not "once per UTC day with cached results": Render's disk is ephemeral and the service restarts often, so a "ran today" marker can't
  persist without new storage, and a bug there would burn the 50/day :free cap. An off flag can never spend a call.
- Today: about 4 OpenRouter :free calls per start, 34 of 50 used. With the flag unset the startup benchmark makes 0 calls and logs
  "[Benchmark] Startup benchmark is off (set SWARM_STARTUP_BENCHMARK=1 to enable)".
- When enabled: targets are groq gpt-oss-120b, groq gpt-oss-20b, openrouter nvidia/nemotron-3-super-120b-a12b:free only (gemma-4-31b dropped).
  Each test runs with noRetry (one attempt per target, so a 429 is never retried; Agent.run normally retries a 429 after 2s) and bypassCache.
  A provider that returns 429 is skipped for the rest of the run.

GROQ-FIRST MORNING (group MG): applied in the engine (agentResolution), only when the run is a morning run.

- Judge (manager seat) moves to groq openai/gpt-oss-120b when it was on gemini, mistral or openrouter and a Groq key exists.
- Every OpenRouter seat is replaced (groq openai/gpt-oss-20b, mistral-small-latest, gemini-3.1-flash-lite, first with a key; one analyst
  seat per Groq model). A seat with no keyed replacement is dropped with a warning.
- Fallback pool for morning runs: groq → mistral → gemini (MORNING_POOL_PROVIDERS). No OpenRouter anywhere in a morning run, including
  fallbacks. MANAGER_CHAIN already has no OpenRouter entry (gemini-2.5-flash, -flash-lite, mistral-small-latest, groq gpt-oss-120b).
- AI Lab / normal analyze runs are untouched and keep OpenRouter (tested).
- Groq caps respected: the judge on Groq uses groqMode 'chat' (18k-char prompt cap, max_tokens = min(2000, 7000 - ceil(chars/4)), skipped
  below 800). The limiter (Groq concurrency 1, 7k tokens/min, skip after a 10s wait) is unchanged. Morning analysts keep the existing
  6k 'morning' cap (that line sits inside round 2's BEFORE block, so it's not touched here; see GAPS).
- Why the engine and not morning/index.ts or buildDefaultAgents: those lines are rewritten by Phase F (morning.test.ts:794, the critic swap).
  Doing it in agentResolution keeps this file conflict-free with every open file.

NEMOTRON COVERAGE (nemotron-3-ultra → nvidia/nemotron-3-super-120b-a12b:free)
Reference (main 2d6e4a7) Covered by
src/swarm/morning/index.ts:38 (critic doc comment) Phase F steps 2-3 (critic swap)
src/swarm/morning/index.ts:67 (critic seat model) Phase F steps 2-3
src/swarm/server/morning.test.ts:136 Phase F steps 2-3
src/swarm/server/morning.test.ts:794 Phase F steps 2-3
Runtime ids sent by DuelOdds AI Lab defaults (DuelOdds main 02f12193: aiLabUtils.ts:181, useSettingsStore.ts:20,
swarmPromptBuilder.ts:817, cloudflareSwarmClient.ts:60, swarmModelService.ts:52) THIS FILE, step 12 (adapter alias; warns once)
DuelOdds cloudflare/src/morningJudgments.ts:164, DuelOdds docs + memory-bank NOT this repo: DuelOdds-side (GAPS)
After Phase F + this file: `git grep -n nemotron-3-ultra -- src` shows only the alias map in openrouter.ts and its test.

COMPATIBILITY / ORDER

- Applies in ANY order with dedupe, round 2, Phase F and round 3 v2. No conflicts. Tested: (a) fresh main + this file; (b) end state + this
  file; (c) this file first, then the four; (d) Phase F → this file → dedupe → round 2 → round 3. (c) and (d) give a tree identical to (b).
- morning/index.ts: this file adds one line after `callerAppId: 'duelodds',` (step 2). Phase F/dedupe edit other parts of the file; the
  anchor is the same on every base.
- Provider chain: no edit to MANAGER_CHAIN, buildDefaultAgents, analystExecution.ts or providers/index.ts. agentResolution.ts and
  synthesisPipeline.ts edits use anchors outside every other file's BEFORE blocks.
- judgePrompt.ts: one else branch (end state ~360, main a few lines earlier), outside every other file's blocks.

STRIP-TYPES CHECK (Render runs `node --experimental-strip-types server.ts`, Node 22, strip-only)

- Every AFTER block and new file uses only erasable TypeScript: no parameter properties, enums, namespaces, `import =`, decorators or `<T>x`.
- Node's own scan (module.stripTypeScriptTypes, mode 'strip'): main + this file 286 files, 0 non-erasable; end state + this file 308 files,
  0 non-erasable.
- `tsc --noEmit --erasableSyntaxOnly --verbatimModuleSyntax`: the same 10 pre-existing TS1484 errors as the base, none in a file this PR
  touches. The filtered command in FINAL VERIFICATION must print nothing.

## HOW TO RUN THIS (one continuous pass)

Do every step from 1 to 13 in one go. Don't stop to submit, report, or open a PR between steps or groups. There's one branch and one PR at the very end.

1. `git pull` on main. Note the base: `BQ_BASE=$(git rev-parse HEAD)` and `git checkout -b fix/morning-cache-bypass-quota`. Never commit to
   main. Use Node >= 22. (The other open swarm PRs may or may not be merged; this file works either way.)
2. After each step passes its Acceptance line, run `git add -A && git commit -m 'step N'` and go straight to the next step.
   (Step 1: the smoke script is already on main, so `git add -A && git commit --allow-empty -m 'step 1'`.)
3. At the end of each group, run the GROUP CHECK shown there. If it's green, keep going.
4. After step 13, run FINAL VERIFICATION once, then push the branch and open a single PR.
5. Never run: git reset (soft or hard), git checkout ., git restore, git clean, git rebase, or any squash. Tyler squashes on merge.
6. Never apply a migration (this PR has none) and never change Render env vars (SWARM_STARTUP_BENCHMARK is documented for Tyler only).
7. Write only erasable TypeScript. Render strips types with Node 22: no parameter properties, enums, namespaces, `import =`, decorators or `<T>x`.
8. Tests must never hit the network: the new tests register provider doubles and stub fetch to throw. Don't add real keys.

## HOW TO READ THE STEPS

- Earlier steps shift later lines in the same file, so find each edit by its BEFORE text and replace it with the AFTER text. The text is what counts.
- "NEW FILE" means create the file with exactly that content.
- Don't refactor, rename or reformat anything outside the quoted blocks.

==========================================================================================
BQ-0: SHARED STARTUP SMOKE TEST (scripts/smoke-start.mjs already on main → empty commit)
==========================================================================================

## STEP 1: NEW FILE scripts/smoke-start.mjs (shared startup smoke test: boots the Dockerfile CMD and hits /api/health)

(SHARED FILE, the same step as in the hotfix, dedupe, round 2, Phase F and round 3 files. It is ALREADY ON MAIN (PR #92, 2d6e4a7; reformatted on merge; the content below is that merged version, sha256 9ffcb9d…, same behavior as the original 594928…). If scripts/smoke-start.mjs exists in ANY formatting, leave it exactly as is and run `git add -A && git commit --allow-empty -m 'step 1'`. Only if it's missing, create it with exactly this content. No npm script is added.)
AFTER (new file):

```js
#!/usr/bin/env node
/**
 * Startup smoke test: boots the server with the REAL Render start command (the Dockerfile CMD,
 * `node --experimental-strip-types server.ts`, read from the Dockerfile), waits for GET /api/health
 * to return 200 {status:"ok"}, then stops it. Exits 0 on success, 1 on failure (and prints the server log).
 * Catches what unit tests can't: syntax Node's strip-only mode rejects (parameter properties, enums,
 * namespaces, ...) and broken runtime imports anywhere in the server.ts import graph.
 * Env is stubbed: no provider keys (no outbound calls), NODE_ENV=production, a smoke app token.
 * Run `npm run build` first (production mode serves ./dist).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.SMOKE_PORT || 3999);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 30000);

const cmdLine = readFileSync("Dockerfile", "utf8")
  .split("\n")
  .filter((l) => /^CMD\s+\[/.test(l))
  .pop();
if (!cmdLine) {
  console.error("[smoke] no exec-form CMD [...] line in Dockerfile");
  process.exit(1);
}
const [bin, ...args] = JSON.parse(cmdLine.replace(/^CMD\s+/, ""));
console.log(
  `[smoke] start command (Dockerfile CMD): ${[bin, ...args].join(" ")}  PORT=${PORT}`,
);

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "production",
  PORT: String(PORT),
  SWARM_APP_TOKENS: "smoke:smoke-token",
};
const child = spawn(bin === "node" ? process.execPath : bin, args, {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => {
  log += d;
});
child.stderr.on("data", (d) => {
  log += d;
});
let exited = null;
child.on("exit", (code, signal) => {
  exited = { code, signal };
});

const fail = (msg) => {
  console.error(
    `[smoke] FAIL: ${msg}\n----- server log -----\n${log}\n----------------------`,
  );
  if (!exited) child.kill("SIGKILL");
  process.exit(1);
};

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  if (exited)
    fail(`server exited early (code ${exited.code}, signal ${exited.signal})`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.status === "ok") {
      console.log(`[smoke] GET /api/health -> 200 ${JSON.stringify(body)}`);
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!exited) child.kill("SIGKILL");
      console.log("[smoke] PASS");
      process.exit(0);
    }
    fail(`GET /api/health -> ${res.status} ${JSON.stringify(body)}`);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
fail(`no healthy response within ${TIMEOUT_MS} ms`);
```

Acceptance: `npm run build && node scripts/smoke-start.mjs` prints `[smoke] GET /api/health -> 200 {"status":"ok","edge":true}` and `[smoke] PASS`, and exits 0.

GROUP CHECK (BQ-0 done): `npm run build && node scripts/smoke-start.mjs`. If it's green, continue straight to the next group without stopping.

==========================================================================================
MC: MORNING CACHE FIX (URGENT, ship before the 10 PM CT run): bypassCache on the morning call. LIVE-CONFIRMED: 36 of 37 swarm judgments on Oct 15-16 are copies of the TB@CLE verdict
==========================================================================================

## STEP 2: morning judge calls bypass every cache (fixes the copied TB@CLE verdicts), in src/swarm/morning/index.ts

(Line numbers: 206-209 on the full end state; 183-186 on main 2d6e4a7 (`originApp`/`callerAppId` right after `executeWorkflowFn({ task, data,` at main:180). Find it by the BEFORE text. bypassCache is already honored by the engine (engine/index.ts:111 → cachingPipeline.ts:136, :227 payload cache, :311 semantic cache) and by Agent.run's payload cache (agent.ts:144).)
2a. The executeWorkflowFn call, at src/swarm/morning/index.ts:206-209
BEFORE:

```ts
        originApp: 'duelodds',
        callerAppId: 'duelodds',
        settings: {
          domain: 'sports-betting',
```

AFTER:

```ts
        originApp: 'duelodds',
        callerAppId: 'duelodds',
        // Every game is judged fresh: no semantic/payload cache hit can copy another game's verdict.
        bypassCache: true,
        settings: {
          domain: 'sports-betting',
```

Acceptance: `npm run lint` passes. `git grep -n "bypassCache: true" -- src/swarm/morning/index.ts` prints one line.

## STEP 3: warn when a judge names neither team (copied verdicts were silently remapped), in src/swarm/morning/judgePrompt.ts

(Debugger's optional hardening #2, warn-only so it can't reject a valid judgment tonight (e.g. a nickname the fuzzy match misses). Line 360-363 on the end state, ~331-333 on main; find it by the BEFORE text.)
3a. LikelyWinner fallback, at src/swarm/morning/judgePrompt.ts:360-363
BEFORE:

```ts
    likelyWinner = normAway;
  } else {
    likelyWinner = winProbHome >= 0.5 ? normHome : normAway;
  }
```

AFTER:

```ts
    likelyWinner = normAway;
  } else {
    // Names neither team (e.g. a verdict copied from another game): keep the probability-based pick, but say so.
    if (likelyWinner) {
      console.warn(`[MorningJudge] likelyWinner "${likelyWinner}" matches neither ${normAway} nor ${normHome}; using the winProbHome side instead.`);
    }
    likelyWinner = winProbHome >= 0.5 ? normHome : normAway;
  }
```

Acceptance: `npm run lint` passes. Behavior is unchanged (the winProbHome side is still used); only a console.warn is added.

## STEP 4: NEW FILE src/swarm/server/morningCacheBypass.test.ts (two games in one run each get their own judge call and verdict)

(Runs the real engine through runMorningSlate with provider doubles registered under the real names (groq, mistral) and global fetch stubbed to throw, so no network call is possible. The judge is recognized by its system prompt ("Morning Swarm Judge"), so the test passes before and after the Groq-morning group moves the judge seat.)
AFTER (new file):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runMorningSlate } from "../morning/index.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { globalSemanticCache, globalPayloadCache } from "../cache.ts";
import {
  globalTokenBudgetManager,
  globalSpecialistProfiler,
  globalNodeCapacityManager,
} from "../loadBalancer.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";

/**
 * Root cause 2026-10-16 (identical ~4s morning judgments): runMorningSlate called the swarm without bypassCache, so the
 * lexical semantic baseline cache (threshold 0.80, task text only) returned game 1's verdict for game 2 with no LLM call.
 * Two NBA games with near-identical prompts: each must get its own provider calls and its own verdict.
 */
const GAMES = [
  {
    id: "nba-g1",
    home: "Boston Celtics",
    away: "New York Knicks",
    spread: -4.5,
    total: 221.5,
    winProbHome: 0.64,
  },
  {
    id: "nba-g2",
    home: "Boston Bruins Hoops",
    away: "New York Nets",
    spread: -2.5,
    total: 219.5,
    winProbHome: 0.41,
  },
];

function espnFetch(): typeof fetch {
  return vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes("/sports/basketball/nba/")) {
      return new Response(
        JSON.stringify({
          events: GAMES.map((g) => ({
            id: g.id,
            date: "2026-10-16T23:30:00Z",
            competitions: [
              {
                venue: { fullName: "Garden", indoor: true },
                competitors: [
                  { homeAway: "home", team: { displayName: g.home } },
                  { homeAway: "away", team: { displayName: g.away } },
                ],
                odds: [
                  {
                    details: `BOS ${g.spread}`,
                    spread: g.spread,
                    overUnder: g.total,
                  },
                ],
              },
            ],
          })),
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  }) as any;
}

const calls: { analyst: string[]; manager: string[] } = {
  analyst: [],
  manager: [],
};

function gameFor(text: string) {
  return GAMES.find((g) => text.includes(`${g.away} @ ${g.home}`));
}

describe("morning run: every game gets its own model call (no cross-game cache hit)", () => {
  beforeEach(() => {
    calls.analyst = [];
    calls.manager = [];
    globalSemanticCache.clear?.();
    (globalPayloadCache as any).clear?.();
    globalTokenBudgetManager.reset();
    globalSpecialistProfiler.reset();
    globalNodeCapacityManager.reset();
    globalProviderLimiter.reset();
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    // No network: any real provider HTTP call fails the test loudly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`unexpected network call in test: ${url}`);
      }),
    );
    // Test doubles registered under the real provider names, after the registry's own init (module state is per test file).
    ProviderRegistry.list();
    // One double for both morning providers: the judge is recognized by its system prompt, so this test doesn't
    // depend on which provider hosts the judge seat.
    for (const providerName of ["groq", "mistral"]) {
      ProviderRegistry.register({
        providerName,
        async call(o: any) {
          const isJudge = String(o.systemInstruction || "").includes(
            "Morning Swarm Judge",
          );
          const g = gameFor(o.prompt);
          if (!isJudge) {
            calls.analyst.push(o.prompt);
            return JSON.stringify({
              insights: [`edge read for ${g?.home}`],
              anomalies: [],
              summary: `lean ${g?.home}`,
            });
          }
          calls.manager.push(o.prompt);
          return JSON.stringify({
            likelyWinner: g!.winProbHome >= 0.5 ? g!.home : g!.away,
            winProbHome: g!.winProbHome,
            winProbAway: Math.round((1 - g!.winProbHome) * 100) / 100,
            fairSpread: g!.spread,
            fairTotal: g!.total,
            totalLean: "none",
            arguments: [],
            invalidationConditions: [],
          });
        },
      } as any);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalProviderLimiter.reset();
  });

  it("two NBA games in one run: two manager calls, analysts called for both games, two different verdicts", async () => {
    const result = await runMorningSlate({
      dateInput: "2026-10-16",
      env: { GROQ_API_KEY: "gsk-test", MISTRAL_API_KEY: "mistral-test" },
      fetchFn: espnFetch(),
    });

    expect(result.ok).toBe(true);
    expect(result.judged).toBe(2);
    // One fresh judge (manager) call per game: a semantic-cache hit would skip the second one.
    expect(calls.manager).toHaveLength(2);
    expect(calls.manager.map((p) => gameFor(p)?.id).sort()).toEqual([
      "nba-g1",
      "nba-g2",
    ]);
    expect(new Set(calls.analyst.map((p) => gameFor(p)?.id))).toEqual(
      new Set(["nba-g1", "nba-g2"]),
    );
  });

  it("the morning call asks the engine to bypass every cache", async () => {
    const seen: any[] = [];
    await runMorningSlate({
      dateInput: "2026-10-16",
      env: { GROQ_API_KEY: "gsk-test" },
      fetchFn: espnFetch(),
      executeWorkflowFn: (async (params: any) => {
        seen.push(params);
        return {
          workflowId: `wf-${seen.length}`,
          finalAnalysis: { winProbHome: 0.5, fairSpread: 0, likelyWinner: "" },
        };
      }) as any,
    });
    expect(seen).toHaveLength(2);
    for (const p of seen) expect(p.bypassCache).toBe(true);
  });
});
```

Acceptance: `npx vitest run src/swarm/server/morningCacheBypass.test.ts` passes: 2 tests. Navigator checked it FAILS without step 2: `expected [ Array(1) ] to have a length of 2 but got 1` (the second game's judge call never happens, the semantic cache answers) and `expected undefined to be true`.

GROUP CHECK (MC done): `npm run lint && npx vitest run src/swarm/server/morningCacheBypass.test.ts src/swarm/server/morning.test.ts && npm run test:unit`. If it's green, continue straight to the next group without stopping.

==========================================================================================
BQ: STARTUP BENCHMARK QUOTA (off by default, no gemma, never retry a 429)
==========================================================================================

## STEP 5: Agent.run: config.noRetry = one attempt per target (so a 429 is never retried), in src/swarm/agent.ts

(Round 3 v2 also edits agent.ts (lines 11-14 and 63-68: the prompt contract). This hunk is at 117-121, separate; it applies with or without round 3.)
5a. Retry count, at src/swarm/agent.ts:117-121
BEFORE:

```ts
            // never recover by retrying; transient (429/5xx/timeout) errors either
            // fail over immediately (when a backup exists) or get one quick retry.
            const maxRetries = 2;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
```

AFTER:

```ts
            // never recover by retrying; transient (429/5xx/timeout) errors either
            // fail over immediately (when a backup exists) or get one quick retry.
            // config.noRetry (startup benchmark): one attempt per target, so a 429 is never retried.
            const maxRetries = config?.noRetry ? 1 : 2;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
```

Acceptance: `npm run lint` passes. Default behavior is unchanged (2 attempts) for every caller that doesn't pass noRetry.

## STEP 6: startup benchmark: off by default (SWARM_STARTUP_BENCHMARK), gemma-4-31b dropped, 429 never retried, a 429 provider is skipped for the rest of the run, in src/swarm/benchmark.ts

(CHOICE: an env flag that is OFF by default, not once-per-UTC-day caching. One line why: Render's filesystem is ephemeral and the service restarts many times a day, so a 'ran today' marker can't survive without new storage (Supabase/KV) and a bug there would burn the 50/day cap again, while an off-by-default flag can never spend a call unless Tyler sets it. When enabled it behaves as before (once at boot, then every 24 h) minus gemma and minus 429 retries. Nothing reads the results at boot: getBestModels() returns null until a run, and cortexDiagnostics.ts already handles null.)
6a. Test result type, 429 helper, the gate and the target list (no gemma), at src/swarm/benchmark.ts:13-16
BEFORE:

```ts
}

export interface BenchmarkTarget {
    provider: Provider;
```

AFTER:

```ts
}

interface BenchmarkTestResult {
    pass: boolean;
    latency: number;
    rateLimited: boolean;
}

/** OpenRouter/Groq 429s surface as "[RATE_LIMIT_429] ..." or "... (429) ...". */
export function isRateLimitError(err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? '');
    return /\b429\b|RATE_LIMIT/i.test(msg);
}

/**
 * Startup benchmark gate. OFF by default: each run costs ~4 OpenRouter :free calls (50/day cap) and Render restarts
 * often, so it only runs when SWARM_STARTUP_BENCHMARK is "1", "true", "yes" or "on".
 */
export const STARTUP_BENCHMARK_ENV = 'SWARM_STARTUP_BENCHMARK';

export function isStartupBenchmarkEnabled(env: Record<string, any> = {}): boolean {
    return /^(1|true|yes|on)$/i.test(String(env?.[STARTUP_BENCHMARK_ENV] ?? '').trim());
}

/** Models the benchmark tests. gemma-4-31b-it:free was dropped (2026-10-16: quota). */
export function buildBenchmarkTargets(env: Record<string, any> = {}): BenchmarkTarget[] {
    const targets: BenchmarkTarget[] = [];
    if (env.GROQ_API_KEY) {
        targets.push({ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: env.GROQ_API_KEY });
        targets.push({ provider: 'groq', modelName: 'openai/gpt-oss-20b', apiKey: env.GROQ_API_KEY });
    }
    if (env.OPENROUTER_API_KEY) {
        targets.push({ provider: 'openrouter', modelName: 'nvidia/nemotron-3-super-120b-a12b:free', apiKey: env.OPENROUTER_API_KEY });
    }
    return targets;
}

export interface BenchmarkTarget {
    provider: Provider;
```

6b. Pause fields (tests set them to 0), at src/swarm/benchmark.ts:23-26
BEFORE:

```ts
    private targets: BenchmarkTarget[] = [];
    private intervalId?: any;

    constructor(targets: BenchmarkTarget[]) {
```

AFTER:

```ts
    private targets: BenchmarkTarget[] = [];
    private intervalId?: any;
    /** Pauses between tests / models (tests set these to 0). */
    public betweenTestsMs = 2000;
    public betweenModelsMs = 5000;

    constructor(targets: BenchmarkTarget[]) {
```

6c. Routing test signature, at src/swarm/benchmark.ts:28-32
BEFORE:

```ts
    }

    private async testRouting(target: BenchmarkTarget): Promise<{ pass: boolean, latency: number }> {
        const agent = new Agent('router-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
```

AFTER:

```ts
    }

    private async testRouting(target: BenchmarkTarget): Promise<BenchmarkTestResult> {
        const agent = new Agent('router-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
```

6d. Routing test: one attempt, 429 flagged, at src/swarm/benchmark.ts:35-49
BEFORE:

```ts
        try {
            const start = Date.now();
            const res = await agent.run(prompt, context, { responseMimeType: 'application/json' });
            const latency = Date.now() - start;
            const pass = typeof res === 'object' && res.intent === 'status';
            return { pass, latency };
        } catch (err) {
            console.warn(`[Benchmark] Routing test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1 };
        }
    }

    private async testReasoning(target: BenchmarkTarget): Promise<{ pass: boolean, latency: number }> {
        const agent = new Agent('reasoning-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
```

AFTER:

```ts
        try {
            const start = Date.now();
            const res = await agent.run(prompt, context, { responseMimeType: 'application/json', noRetry: true, bypassCache: true });
            const latency = Date.now() - start;
            const pass = typeof res === 'object' && res.intent === 'status';
            return { pass, latency, rateLimited: false };
        } catch (err) {
            console.warn(`[Benchmark] Routing test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1, rateLimited: isRateLimitError(err) };
        }
    }

    private async testReasoning(target: BenchmarkTarget): Promise<BenchmarkTestResult> {
        const agent = new Agent('reasoning-tester', target.modelName, target.provider, target.apiKey);
        const context = new SwarmContext();
```

6e. Reasoning test: one attempt, 429 flagged, at src/swarm/benchmark.ts:53-65
BEFORE:

```ts
            const start = Date.now();
            // Free tier reasoning models might take a while, 60s timeout
            const res = await agent.run(prompt, context, { timeoutMs: 60000 });
            const latency = Date.now() - start;
            // The correct answer is 5 cents.
            const textOutput = typeof res === 'string' ? res : JSON.stringify(res);
            const pass = textOutput.includes('5');
            return { pass, latency };
        } catch (err) {
            console.warn(`[Benchmark] Reasoning test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1 };
        }
    }
```

AFTER:

```ts
            const start = Date.now();
            // Free tier reasoning models might take a while, 60s timeout
            const res = await agent.run(prompt, context, { timeoutMs: 60000, noRetry: true, bypassCache: true });
            const latency = Date.now() - start;
            // The correct answer is 5 cents.
            const textOutput = typeof res === 'string' ? res : JSON.stringify(res);
            const pass = textOutput.includes('5');
            return { pass, latency, rateLimited: false };
        } catch (err) {
            console.warn(`[Benchmark] Reasoning test failed for ${target.provider}/${target.modelName}:`, err);
            return { pass: false, latency: -1, rateLimited: isRateLimitError(err) };
        }
    }
```

6f. Run(): skip a provider after its 429, at src/swarm/benchmark.ts:68-84
BEFORE:

```ts
        console.log(`[Benchmark] Starting benchmark run for ${this.targets.length} models...`);
        const results: BenchmarkResult[] = [];

        for (const target of this.targets) {
            console.log(`[Benchmark] Testing ${target.provider}/${target.modelName}...`);

            // 1. Routing test (fast)
            const routing = await this.testRouting(target);

            // 2. Reasoning test (slow)
            let reasoning = { pass: false, latency: -1 };
            if (routing.pass) {
                // To avoid immediate rate limits, wait 2 seconds
                await new Promise(resolve => setTimeout(resolve, 2000));
                reasoning = await this.testReasoning(target);
            }

```

AFTER:

```ts
        console.log(`[Benchmark] Starting benchmark run for ${this.targets.length} models...`);
        const results: BenchmarkResult[] = [];
        // A provider that answered 429 is not called again in this run (no retry, no further models on it).
        const rateLimitedProviders = new Set<string>();

        for (const target of this.targets) {
            if (rateLimitedProviders.has(target.provider)) {
                console.warn(`[Benchmark] Skipping ${target.provider}/${target.modelName}: ${target.provider} returned 429 earlier in this run.`);
                continue;
            }
            console.log(`[Benchmark] Testing ${target.provider}/${target.modelName}...`);

            // 1. Routing test (fast)
            const routing = await this.testRouting(target);
            if (routing.rateLimited) rateLimitedProviders.add(target.provider);

            // 2. Reasoning test (slow)
            let reasoning: BenchmarkTestResult = { pass: false, latency: -1, rateLimited: false };
            if (routing.pass) {
                // To avoid immediate rate limits, wait 2 seconds
                await new Promise(resolve => setTimeout(resolve, this.betweenTestsMs));
                reasoning = await this.testReasoning(target);
                if (reasoning.rateLimited) rateLimitedProviders.add(target.provider);
            }

```

6g. Run(): pause between models, at src/swarm/benchmark.ts:94-98
BEFORE:

```ts

            // Wait between models to respect rate limits
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

```

AFTER:

```ts

            // Wait between models to respect rate limits
            await new Promise(resolve => setTimeout(resolve, this.betweenModelsMs));
        }

```

6h. InitBenchmarker: gated, returns whether it started, at src/swarm/benchmark.ts:137-157
BEFORE:

```ts
export const globalBenchmarker = new SwarmBenchmarker([]);

export function initBenchmarker(env: Record<string, any>) {
  const targets: BenchmarkTarget[] = [];

  if (env.GROQ_API_KEY) {
    targets.push({
      provider: "groq",
      modelName: "openai/gpt-oss-120b",
      apiKey: env.GROQ_API_KEY,
    });
    targets.push({
      provider: "groq",
      modelName: "openai/gpt-oss-20b",
      apiKey: env.GROQ_API_KEY,
    });
  }

  if (env.OPENROUTER_API_KEY) {
    targets.push({
      provider: "openrouter",
      modelName: "nvidia/nemotron-3-super-120b-a12b:free",
      apiKey: env.OPENROUTER_API_KEY,
    });
    targets.push({
      provider: "openrouter",
      modelName: "google/gemma-4-31b-it:free",
      apiKey: env.OPENROUTER_API_KEY,
    });
  }

  if (targets.length > 0) {
    globalBenchmarker["targets"] = targets; // update targets
    globalBenchmarker.startSchedule();
  }
}
```

AFTER:

```ts
export const globalBenchmarker = new SwarmBenchmarker([]);

/** Returns true when the benchmark schedule was started. Off unless SWARM_STARTUP_BENCHMARK is set (see above). */
export function initBenchmarker(env: Record<string, any>): boolean {
  if (!isStartupBenchmarkEnabled(env)) {
    console.log(
      `[Benchmark] Startup benchmark is off (set ${STARTUP_BENCHMARK_ENV}=1 to enable). No provider calls at boot.`,
    );
    return false;
  }
  const targets = buildBenchmarkTargets(env);
  if (targets.length > 0) {
    globalBenchmarker["targets"] = targets; // update targets
    globalBenchmarker.startSchedule();
    return true;
  }
  return false;
}
```

Acceptance: `npm run lint` passes. `git grep -n gemma -- src/swarm/benchmark.ts` prints nothing.

## STEP 7: NEW FILE src/swarm/benchmark.test.ts (gate, no gemma, exactly one call per provider on 429)

AFTER (new file):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SwarmBenchmarker,
  buildBenchmarkTargets,
  initBenchmarker,
  isStartupBenchmarkEnabled,
  isRateLimitError,
  globalBenchmarker,
  STARTUP_BENCHMARK_ENV,
} from "./benchmark.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { globalProviderLimiter } from "./providers/limiter.ts";

const KEYS = { GROQ_API_KEY: "gsk-test", OPENROUTER_API_KEY: "sk-or-v1-test" };
const calls: string[] = [];

describe("startup benchmark: gated, no gemma, never retries a 429", () => {
  beforeEach(() => {
    calls.length = 0;
    globalProviderLimiter.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`unexpected network call in test: ${url}`);
      }),
    );
    ProviderRegistry.list(); // registry init first, then the doubles replace the real adapters
    for (const providerName of ["groq", "openrouter"]) {
      ProviderRegistry.register({
        providerName,
        async call(o: any) {
          calls.push(`${providerName}/${o.modelName}`);
          throw new Error(
            `[RATE_LIMIT_429] ${providerName} rate limit: free-models-per-min`,
          );
        },
      } as any);
    }
  });

  afterEach(() => {
    globalBenchmarker.stopSchedule();
    vi.unstubAllGlobals();
    globalProviderLimiter.reset();
  });

  it(`is off by default; only ${STARTUP_BENCHMARK_ENV}=1/true/yes/on turns it on`, () => {
    expect(isStartupBenchmarkEnabled({})).toBe(false);
    expect(isStartupBenchmarkEnabled({ ...KEYS })).toBe(false);
    expect(isStartupBenchmarkEnabled({ [STARTUP_BENCHMARK_ENV]: "0" })).toBe(
      false,
    );
    expect(
      isStartupBenchmarkEnabled({ [STARTUP_BENCHMARK_ENV]: "false" }),
    ).toBe(false);
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(isStartupBenchmarkEnabled({ [STARTUP_BENCHMARK_ENV]: v })).toBe(
        true,
      );
    }
  });

  it("initBenchmarker with provider keys but no flag makes zero provider calls", async () => {
    expect(initBenchmarker({ ...KEYS })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it("targets: no gemma-4-31b; one OpenRouter model (nemotron-3-super :free)", () => {
    const ids = buildBenchmarkTargets(KEYS).map(
      (t) => `${t.provider}/${t.modelName}`,
    );
    expect(ids).toEqual([
      "groq/openai/gpt-oss-120b",
      "groq/openai/gpt-oss-20b",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    expect(ids.join(" ")).not.toMatch(/gemma/i);
  });

  it("a 429 is never retried and the rest of that provider is skipped: exactly one call per provider", async () => {
    const b = new SwarmBenchmarker(buildBenchmarkTargets(KEYS));
    b.betweenTestsMs = 0;
    b.betweenModelsMs = 0;
    const results = await b.run();
    expect(calls).toEqual([
      "groq/openai/gpt-oss-120b",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    expect(results.map((r) => r.modelName)).toEqual([
      "openai/gpt-oss-120b",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    expect(results.every((r) => !r.passRouting && !r.passReasoning)).toBe(true);
  });

  it("isRateLimitError recognizes the adapters' 429 messages", () => {
    expect(
      isRateLimitError(
        new Error(
          "[RATE_LIMIT_429] OpenRouter rate limit / credit exhaustion: x",
        ),
      ),
    ).toBe(true);
    expect(
      isRateLimitError(new Error("Groq API Error (429): too many requests")),
    ).toBe(true);
    expect(
      isRateLimitError(new Error("OpenRouter API Error (404): no endpoints")),
    ).toBe(false);
  });
});
```

Acceptance: `npx vitest run src/swarm/benchmark.test.ts` passes: 5 tests (no network: fetch is stubbed to throw).

GROUP CHECK (BQ done): `npm run lint && npx vitest run src/swarm/benchmark.test.ts && npm run test:unit && npm run build && node scripts/smoke-start.mjs`. If it's green, continue straight to the next group without stopping.

==========================================================================================
MG: MORNING RUNS PREFER GROQ, NEVER OPENROUTER (judge, every seat, every fallback); AI Lab unchanged
==========================================================================================

## STEP 8: NEW FILE src/swarm/engine/morningProviders.ts (morning: judge on Groq, no OpenRouter seat, Groq-first fallbacks)

(Applied in the ENGINE (next step), not in morning/index.ts: buildDefaultAgents and the single-Groq-seat filter in morning/index.ts are left untouched, so this group never collides with Phase F (which edits buildDefaultAgents' critic lines and morning.test.ts:136/794) or the dedupe (which edits morning/index.ts 18-26, 87-107, 156-173, 266-270). Groq caps: every Groq call still goes through groq.ts (prompt char cap, max_tokens rule, < 800 → skip) and the limiter's 7k tokens/min + concurrency 1 (limiter.ts:14), so when Groq is busy a seat falls over to Mistral/Gemini, never OpenRouter.)
AFTER (new file):

```ts
import type { AgentConfig, Provider, SwarmEngineSettings } from "../types.ts";
import { resolveProvider } from "./utils.ts";

/**
 * Morning runs (responseSchema 'morning_judge') prefer Groq and never use OpenRouter (2026-10-16: the OpenRouter
 * :free cap is 50 calls/day and Tyler won't buy credits). AI Lab / chat runs are not touched.
 * Groq's own caps still apply to every Groq call (groq.ts: prompt char cap, max_tokens rule, < 800 => skip to the
 * next fallback) and the limiter's 7k tokens/min budget (limiter.ts), so a busy Groq falls back to Mistral/Gemini.
 */
export const MORNING_POOL_PROVIDERS: Provider[] = ["groq", "mistral", "gemini"];
export const MORNING_GROQ_JUDGE_MODEL = "openai/gpt-oss-120b";

/** Where a morning seat that asked for OpenRouter goes instead, in order (first one with a key and a free Groq model). */
export const MORNING_SEAT_REPLACEMENTS: ReadonlyArray<{
  provider: Provider;
  model: string;
}> = [
  { provider: "groq" as Provider, model: "openai/gpt-oss-20b" },
  { provider: "mistral" as Provider, model: "mistral-small-latest" },
  { provider: "gemini" as Provider, model: "gemini-3.1-flash-lite" },
];

const MOVABLE_JUDGE_PROVIDERS = new Set<string>([
  "gemini",
  "mistral",
  "openrouter",
]);

function isManagerSeat(a: AgentConfig): boolean {
  return a.id === "manager" || a.role === "Manager Node";
}

/**
 * - The judge (manager seat) on Gemini, Mistral or OpenRouter runs on Groq gpt-oss-120b when a Groq key exists; otherwise it keeps its seat,
 *   unless that seat is OpenRouter, which is replaced like any other seat.
 * - Every other OpenRouter seat is replaced (Groq gpt-oss-20b, then Mistral, then Gemini). With no key for any of
 *   them the seat is dropped.
 * - At most one analyst seat per Groq model (each Groq model has its own rate limit), so a2 keeps gpt-oss-120b
 *   and a replaced critic takes gpt-oss-20b.
 */
export function applyMorningProviderPolicy(
  agents: AgentConfig[],
  settings: SwarmEngineSettings | undefined,
): AgentConfig[] {
  const hasKey = (p: string) =>
    !!resolveProvider(p, (settings || {}) as SwarmEngineSettings).key;
  const usedGroqModels = new Set(
    agents
      .filter((a) => !isManagerSeat(a) && a.provider === "groq")
      .map((a) => a.model),
  );
  const out: AgentConfig[] = [];
  for (const a of agents) {
    // Only seats on a real hosted provider move (custom / mock / simulated seats are left alone).
    if (
      isManagerSeat(a) &&
      MOVABLE_JUDGE_PROVIDERS.has(a.provider) &&
      hasKey("groq")
    ) {
      out.push({
        ...a,
        provider: "groq",
        model: MORNING_GROQ_JUDGE_MODEL,
        apiKey: undefined,
      });
      continue;
    }
    if (a.provider !== "openrouter") {
      out.push(a);
      continue;
    }
    const pick = MORNING_SEAT_REPLACEMENTS.find(
      (r) =>
        hasKey(r.provider) &&
        !(
          r.provider === "groq" &&
          !isManagerSeat(a) &&
          usedGroqModels.has(r.model)
        ),
    );
    if (!pick) {
      console.warn(
        `[Morning] Dropping seat ${a.id || a.role}: OpenRouter is not used for morning runs and no Groq/Mistral/Gemini key is set.`,
      );
      continue;
    }
    if (pick.provider === "groq" && !isManagerSeat(a))
      usedGroqModels.add(pick.model);
    out.push({
      ...a,
      provider: pick.provider,
      model: pick.model,
      apiKey: undefined,
    });
  }
  return out;
}
```

Acceptance: `npm run lint` passes. Nothing imports it yet.

## STEP 9: resolveSwarmAgents: morning runs use the policy and a Groq → Mistral → Gemini fallback pool (no OpenRouter), in src/swarm/engine/agentResolution.ts

(AI Lab / chat runs (no responseSchema 'morning_judge') get exactly the agents and pool they got before. The manager chain (managerChain.ts) has no OpenRouter entry, so the judge's fallbacks are gemini-2.5-flash, gemini-2.5-flash-lite, mistral-small-latest plus the morning pool.)
9a. Import, at src/swarm/engine/agentResolution.ts:8-11
BEFORE:

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

const safeEnv =
  typeof process !== "undefined"
    ? process.env
    : ({} as Record<string, string | undefined>);
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
import {
  applyMorningProviderPolicy,
  MORNING_POOL_PROVIDERS,
} from "./morningProviders.ts";

const safeEnv =
  typeof process !== "undefined"
    ? process.env
    : ({} as Record<string, string | undefined>);
```

9b. Requested agents → morning policy, at src/swarm/engine/agentResolution.ts:67-73
BEFORE:

```ts
    defaultAi?: GoogleGenAI
): ResolvedSwarmAgents {
    const rawAgents = (activeVariant?.agents && activeVariant.agents.length > 0)
        ? activeVariant.agents
        : (settings?.agents || []);
    let managerConfig = rawAgents.find((a: AgentConfig) => a.id === 'manager' || a.role === 'Manager Node');
    const dedicatedCriticConfig = rawAgents.find((a: AgentConfig) => a.id === 'critic' || a.role?.toLowerCase().includes('critic') || a.role?.toLowerCase().includes('verifier')) || settings?.critic;
```

AFTER:

```ts
    defaultAi?: GoogleGenAI
): ResolvedSwarmAgents {
    const requestedAgents = (activeVariant?.agents && activeVariant.agents.length > 0)
        ? activeVariant.agents
        : (settings?.agents || []);
    // Morning runs (morning_judge): judge on Groq, no OpenRouter seat (see morningProviders.ts). Other runs unchanged.
    const isMorningRun = (settings as any)?.responseSchema === 'morning_judge';
    const rawAgents = isMorningRun ? applyMorningProviderPolicy(requestedAgents, settings) : requestedAgents;
    let managerConfig = rawAgents.find((a: AgentConfig) => a.id === 'manager' || a.role === 'Manager Node');
    const dedicatedCriticConfig = rawAgents.find((a: AgentConfig) => a.id === 'critic' || a.role?.toLowerCase().includes('critic') || a.role?.toLowerCase().includes('verifier')) || settings?.critic;
```

9c. Morning fallback pool, at src/swarm/engine/agentResolution.ts:86-94
BEFORE:

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

const { key: mKey, client: mClient } = resolveProvider(
  managerConfig.provider,
  settings,
  defaultAi,
);
```

AFTER:

```ts
// PS3: global analyst fallback pool. Any keyed, healthy provider can cover a failed seat,
// not only providers that already have a seat in this run.
// Morning runs (morning_judge) do NOT borrow from the global pool: seat-model providers only (pre-PS3 behavior),
// Groq first and never OpenRouter.
const availableFallbacks: ProviderCredential[] = settings?.disableFallback
  ? []
  : buildAnalystPool(
      isMorningRun ? MORNING_POOL_PROVIDERS : ALL_PROVIDERS,
      settings,
      rawAgents,
      defaultAi,
      { seatModelsOnly: isMorningRun },
    );

const { key: mKey, client: mClient } = resolveProvider(
  managerConfig.provider,
  settings,
  defaultAi,
);
```

Acceptance: `npm run lint` passes. `npx vitest run src/swarm/engine/managerChain.test.ts src/swarm/engine/partialResult.test.ts src/swarm/server/morning.test.ts` passes.

## STEP 10: the morning judge on Groq uses the chat caps (18k chars, max_tokens rule), in src/swarm/engine/synthesisPipeline.ts

(Before, the morning judge got the legacy 6k-char cap, which can cut the debate transcript. Now: prompt capped at 18,000 chars and max_tokens = min(2000, 7000 - ceil(chars/4)); below 800 Groq is skipped and the judge moves to its next fallback. Morning analysts (analystExecution.ts) keep groqMode 'morning' on purpose: their prompts are short, and that line sits inside round 2's rewritten block (editing it would make the order matter).)
10a. Manager run config, at src/swarm/engine/synthesisPipeline.ts:215-219
BEFORE:

```ts
        zodSchema,
        bypassCache,
        groqMode: isMorningJudge ? 'morning' : 'chat',
        ...activeVariant?.parameters
    });
```

AFTER:

```ts
        zodSchema,
        bypassCache,
        // The morning judge on Groq gets the chat caps too (18k-char prompt, max_tokens = min(2000, 7000 - ceil(chars/4)),
        // < 800 => skip to the next fallback), so its debate transcript isn't cut at the 6k legacy cap.
        groqMode: 'chat',
        ...activeVariant?.parameters
    });
```

Acceptance: `npm run lint` passes. `npx vitest run src/swarm/providers/groq.mode.test.ts src/swarm/providers/groq.cap.test.ts` passes.

## STEP 11: NEW FILE src/swarm/engine/morningProviders.test.ts (policy; end to end: no OpenRouter call even with Groq down; AI Lab keeps OpenRouter)

AFTER (new file):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyMorningProviderPolicy,
  MORNING_GROQ_JUDGE_MODEL,
} from "./morningProviders.ts";
import { buildDefaultAgents, runMorningSlate } from "../morning/index.ts";
import { executeSwarmWorkflow } from "./index.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { globalSemanticCache } from "../cache.ts";
import {
  globalTokenBudgetManager,
  globalSpecialistProfiler,
  globalNodeCapacityManager,
} from "../loadBalancer.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";

const ALL = {
  GEMINI_API_KEY: "g-key",
  GROQ_API_KEY: "gsk-key",
  OPENROUTER_API_KEY: "sk-or-v1-key",
  MISTRAL_API_KEY: "m-key",
};
const settingsFor = (env: Record<string, string>) =>
  ({
    responseSchema: "morning_judge",
    geminiApiKey: env.GEMINI_API_KEY,
    groqApiKey: env.GROQ_API_KEY,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    mistralApiKey: env.MISTRAL_API_KEY,
  }) as any;
const seats = (agents: any[]) =>
  agents.map((a) => `${a.id}:${a.provider}/${a.model}`);

describe("morning provider policy (Groq first, never OpenRouter)", () => {
  beforeEach(() => {
    for (const k of [
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "MISTRAL_API_KEY",
    ])
      vi.stubEnv(k, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("all keys: judge on Groq gpt-oss-120b, the OpenRouter critic moves to Groq gpt-oss-20b, a1/a2 unchanged", () => {
    const out = applyMorningProviderPolicy(
      buildDefaultAgents(ALL),
      settingsFor(ALL),
    );
    expect(seats(out)).toEqual([
      "a1:gemini/gemini-3.1-flash-lite",
      "a2:groq/openai/gpt-oss-120b",
      "critic:groq/openai/gpt-oss-20b",
      `manager:groq/${MORNING_GROQ_JUDGE_MODEL}`,
    ]);
    expect(out.some((a) => a.provider === "openrouter")).toBe(false);
  });

  it("no Groq key: critic goes to Mistral, the judge keeps Mistral", () => {
    const env = {
      GEMINI_API_KEY: "g",
      OPENROUTER_API_KEY: "sk-or-v1-x",
      MISTRAL_API_KEY: "m",
    };
    expect(
      seats(
        applyMorningProviderPolicy(buildDefaultAgents(env), settingsFor(env)),
      ),
    ).toEqual([
      "a1:gemini/gemini-3.1-flash-lite",
      "critic:mistral/mistral-small-latest",
      "manager:mistral/mistral-small-latest",
    ]);
  });

  it("OpenRouter + Gemini only: critic goes to Gemini; OpenRouter only: the critic seat is dropped", () => {
    const env1 = { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "sk-or-v1-x" };
    expect(
      seats(
        applyMorningProviderPolicy(buildDefaultAgents(env1), settingsFor(env1)),
      ),
    ).toEqual([
      "a1:gemini/gemini-3.1-flash-lite",
      "critic:gemini/gemini-3.1-flash-lite",
    ]);
    const env2 = { OPENROUTER_API_KEY: "sk-or-v1-x" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      applyMorningProviderPolicy(buildDefaultAgents(env2), settingsFor(env2)),
    ).toEqual([]);
  });
});

describe("morning run end to end: no OpenRouter call, even as a fallback; AI Lab still uses OpenRouter", () => {
  const calls: Array<{ provider: string; model: string; judge: boolean }> = [];
  let groqDown = false;

  function espnFetch(): typeof fetch {
    return vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/sports/football/nfl/")) {
        return new Response(
          JSON.stringify({
            events: [
              {
                id: "nfl-1",
                date: "2026-10-18T17:00:00Z",
                competitions: [
                  {
                    competitors: [
                      {
                        homeAway: "home",
                        team: { displayName: "Kansas City Chiefs" },
                      },
                      {
                        homeAway: "away",
                        team: { displayName: "Denver Broncos" },
                      },
                    ],
                    odds: [
                      { details: "KC -6.5", spread: -6.5, overUnder: 44.5 },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as any;
  }

  beforeEach(() => {
    calls.length = 0;
    groqDown = false;
    globalSemanticCache.clear();
    globalTokenBudgetManager.reset();
    globalSpecialistProfiler.reset();
    globalNodeCapacityManager.reset();
    globalProviderLimiter.reset();
    for (const k of [
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "MISTRAL_API_KEY",
    ])
      vi.stubEnv(k, "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`unexpected network call in test: ${url}`);
      }),
    );
    ProviderRegistry.list();
    for (const providerName of ["gemini", "groq", "openrouter", "mistral"]) {
      ProviderRegistry.register({
        providerName,
        async call(o: any) {
          const sys = String(o.systemInstruction || "");
          const judge =
            sys.includes("Morning Swarm Judge") ||
            sys.includes("Swarm Orchestrator");
          calls.push({ provider: providerName, model: o.modelName, judge });
          if (providerName === "groq" && groqDown)
            throw new Error("[RATE_LIMIT_429] Groq rate limit");
          if (!judge)
            return JSON.stringify({
              insights: ["KC rested"],
              anomalies: [],
              summary: "lean KC",
            });
          if (sys.includes("Morning Swarm Judge")) {
            return JSON.stringify({
              likelyWinner: "Kansas City Chiefs",
              winProbHome: 0.66,
              winProbAway: 0.34,
              fairSpread: -6,
              fairTotal: 44,
              totalLean: "none",
              arguments: [],
              invalidationConditions: [],
            });
          }
          return JSON.stringify({
            ui_title: "Call",
            summary: "Lean KC.",
            components: [],
          });
        },
      } as any);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalProviderLimiter.reset();
  });

  it("all four keys: the judge call is on Groq gpt-oss-120b and nothing calls OpenRouter", async () => {
    const result = await runMorningSlate({
      dateInput: "2026-10-18",
      env: { ...ALL },
      fetchFn: espnFetch(),
    });
    expect(result.judged).toBe(1);
    expect(calls.filter((c) => c.provider === "openrouter")).toEqual([]);
    expect(calls.find((c) => c.judge)).toMatchObject({
      provider: "groq",
      model: MORNING_GROQ_JUDGE_MODEL,
    });
    expect(
      calls.some(
        (c) =>
          !c.judge && c.provider === "groq" && c.model === "openai/gpt-oss-20b",
      ),
    ).toBe(true);
  });

  it("Groq down (429): seats and the judge fall back to Mistral/Gemini, never OpenRouter", async () => {
    groqDown = true;
    const result = await runMorningSlate({
      dateInput: "2026-10-18",
      env: { ...ALL },
      fetchFn: espnFetch(),
    });
    expect(result.judged).toBe(1);
    expect(calls.filter((c) => c.provider === "openrouter")).toEqual([]);
    const judgeCalls = calls.filter((c) => c.judge);
    expect(judgeCalls[0].provider).toBe("groq");
    expect(
      judgeCalls.some(
        (c) => c.provider === "gemini" || c.provider === "mistral",
      ),
    ).toBe(true);
  });

  it("AI Lab (no morning_judge) keeps its OpenRouter seat", async () => {
    await executeSwarmWorkflow({
      task: "Build a parlay",
      data: "id|event|pick\nR1|DEN @ KC|KC",
      forceFullSwarm: true,
      bypassCache: true,
      enableDeepAnalysis: false,
      settings: {
        appId: "ailab-test",
        openRouterApiKey: ALL.OPENROUTER_API_KEY,
        geminiApiKey: ALL.GEMINI_API_KEY,
        disableFallback: true,
        agents: [
          {
            id: "manager",
            role: "Manager Node",
            provider: "gemini",
            model: "gemini-2.5-flash",
          },
          {
            id: "critic",
            role: "Risk Critic",
            provider: "openrouter",
            model: "nvidia/nemotron-3-super-120b-a12b:free",
          },
        ],
      },
    } as any);
    expect(calls.some((c) => c.provider === "openrouter")).toBe(true);
  });
});
```

Acceptance: `npx vitest run src/swarm/engine/morningProviders.test.ts` passes: 6 tests (no network).

GROUP CHECK (MG done): `npm run lint && npx vitest run src/swarm/engine/morningProviders.test.ts src/swarm/server/morningCacheBypass.test.ts src/swarm/server/morning.test.ts && npm run test:unit`. If it's green, continue straight to the next group without stopping.

==========================================================================================
NM: NEMOTRON-3-ULTRA COVERAGE (runtime alias for what Phase F misses)
==========================================================================================

## STEP 12: OpenRouter adapter maps the dead nemotron-3-ultra :free id to nemotron-3-super :free, in src/swarm/providers/openrouter.ts

(Coverage (see the NEMOTRON COVERAGE table in the header): every static nemotron-3-ultra reference in this repo is already swapped by Phase F steps 2-3. What Phase F misses is the id arriving at RUNTIME: DuelOdds' AI Lab defaults still send it (aiLabUtils.ts:181, useSettingsStore.ts:20, swarmPromptBuilder.ts:817, cloudflareSwarmClient.ts:60, swarmModelService.ts:52; DuelOdds main 02f12193). This map sends the live model instead, with one warning per process. Evidence for nvidia/nemotron-3-super-120b-a12b:free: Phase F step 2 (OpenRouter endpoints API, Oct 16 2:20 PM CT: status 0, 100% uptime, $0).)
12a. Retired-model map, at src/swarm/providers/openrouter.ts:1-3
BEFORE:

```ts
import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class OpenRouterAdapter implements ProviderAdapter {
```

AFTER:

```ts
import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

/**
 * Dead OpenRouter ids that callers still send (DuelOdds AI Lab defaults: aiLabUtils.ts:181, useSettingsStore.ts:20,
 * swarmPromptBuilder.ts:817, cloudflareSwarmClient.ts:60) mapped to the live free model. nemotron-3-ultra :free
 * returns 404 (its only endpoint: status -5, 0% uptime; Navigator, Oct 16 2:20 PM CT).
 */
export const RETIRED_OPENROUTER_MODELS: Readonly<Record<string, string>> = {
    'nvidia/nemotron-3-ultra-550b-a55b:free': 'nvidia/nemotron-3-super-120b-a12b:free'
};
const warnedRetired = new Set<string>();

export function resolveOpenRouterModel(modelName: string): string {
    const replacement = RETIRED_OPENROUTER_MODELS[String(modelName || '').trim()];
    if (!replacement) return modelName;
    if (!warnedRetired.has(modelName)) {
        warnedRetired.add(modelName);
        console.warn(`[OpenRouter] Model '${modelName}' is retired (404); using '${replacement}' instead.`);
    }
    return replacement;
}

export class OpenRouterAdapter implements ProviderAdapter {
```

12b. Model sent to OpenRouter, at src/swarm/providers/openrouter.ts:18-22
BEFORE:

```ts
const isJson = options.config?.responseMimeType === "application/json";
const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes
const effectiveModel = options.modelName;

const startTime = Date.now();
```

AFTER:

```ts
const isJson = options.config?.responseMimeType === "application/json";
const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes
const effectiveModel = resolveOpenRouterModel(options.modelName);

const startTime = Date.now();
```

Acceptance: `npm run lint` passes.

## STEP 13: NEW FILE src/swarm/providers/openrouter.alias.test.ts

AFTER (new file):

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  OpenRouterAdapter,
  resolveOpenRouterModel,
  RETIRED_OPENROUTER_MODELS,
} from "./openrouter.ts";

const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b:free";
const SUPER = "nvidia/nemotron-3-super-120b-a12b:free";

describe("OpenRouter retired-model alias (nemotron-3-ultra → nemotron-3-super :free)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps the dead ultra id to super and leaves every other id alone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(RETIRED_OPENROUTER_MODELS[ULTRA]).toBe(SUPER);
    expect(resolveOpenRouterModel(ULTRA)).toBe(SUPER);
    expect(resolveOpenRouterModel(SUPER)).toBe(SUPER);
    expect(resolveOpenRouterModel("google/gemma-4-31b-it:free")).toBe(
      "google/gemma-4-31b-it:free",
    );
  });

  it("an AI Lab request for the ultra id goes out as super", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
          { status: 200 },
        );
      }),
    );
    await new OpenRouterAdapter().call({
      modelName: ULTRA,
      prompt: "hi",
      apiKey: "sk-or-v1-test",
    } as any);
    expect(bodies[0].model).toBe(SUPER);
  });
});
```

Acceptance: `npx vitest run src/swarm/providers/openrouter.alias.test.ts` passes: 2 tests.

GROUP CHECK (NM done): `npm run lint && npm run test:unit && npm run test:simulation && npm run test:portable`. If it's green, continue to FINAL VERIFICATION.

==========================================================================================
FINAL VERIFICATION (run once after step 13, Node >= 22)
==========================================================================================

1. `npm run lint` → exit 0 (tsc --noEmit).
2. `npm run test:unit` → all green (Navigator: 869 passed on main + the four open files = 854 + 15 new;
   776 passed on main 2d6e4a7 alone = 761 + 15 new).
3. `npm run test:simulation` → exit 0.
4. `npm run test:portable` → exit 0.
5. `npm run build` → exit 0.
6. New tests, by name:
   `npx vitest run src/swarm/server/morningCacheBypass.test.ts src/swarm/benchmark.test.ts src/swarm/engine/morningProviders.test.ts src/swarm/providers/openrouter.alias.test.ts`
   → all green (Navigator: 4 files, 15 tests: 2 + 5 + 6 + 2).
7. Startup smoke (Render's real start command): `npm run build && node scripts/smoke-start.mjs` → `[smoke] start command (Dockerfile CMD):
node --experimental-strip-types server.ts  PORT=3999`, `[smoke] GET /api/health -> 200 ...`, `[smoke] PASS`, exit 0.
8. Strip-types scan 1 (Node's own stripper), must print `strip scan: N files, 0 non-erasable` and exit 0:
   node --no-warnings --input-type=module -e "import {stripTypeScriptTypes as s} from 'node:module';import fs from 'node:fs';const fl=process.argv.slice(1);let b=0;for(const f of fl){try{s(fs.readFileSync(f,'utf8'),{mode:'strip'})}catch(e){b++;console.log('NON-ERASABLE',f,e.message.split('\n')[0])}}console.log('strip scan:',fl.length,'files,',b,'non-erasable');process.exit(b?1:0)" $(git ls-files 'server.ts' 'src/\*_/_.ts' 'scripts/_.ts' 'test-_.ts')
   (Navigator: 286 files on main + this file; 308 on the full end state.)
9. Strip-types scan 2 (tsc), filtered to this PR's files, must print NOTHING:
   npx tsc --noEmit --erasableSyntaxOnly --verbatimModuleSyntax | grep -E "morning/index\.ts|judgePrompt|morningCacheBypass|src/swarm/agent\.ts|benchmark|morningProviders|agentResolution|synthesisPipeline|providers/openrouter"
   (Unfiltered it shows the 10 pre-existing TS1484 errors. Leave those alone.)
10. Greps:
    `git grep -n "bypassCache: true" -- src/swarm/morning/index.ts` → one line.
    `git grep -n gemma -- src/swarm/benchmark.ts` → nothing.
    `git grep -n "SWARM_STARTUP_BENCHMARK" -- src/swarm/benchmark.ts` → the flag constant.
11. Files changed vs $BQ_BASE (`git diff --stat $BQ_BASE`), 12 files:
    src/swarm/morning/index.ts
    src/swarm/morning/judgePrompt.ts
    src/swarm/server/morningCacheBypass.test.ts (new)
    src/swarm/agent.ts
    src/swarm/benchmark.ts
    src/swarm/benchmark.test.ts (new)
    src/swarm/engine/morningProviders.ts (new)
    src/swarm/engine/agentResolution.ts
    src/swarm/engine/synthesisPipeline.ts
    src/swarm/engine/morningProviders.test.ts (new)
    src/swarm/providers/openrouter.ts
    src/swarm/providers/openrouter.alias.test.ts (new)
    (scripts/smoke-start.mjs is NOT in the list: step 1 is an empty commit.)

Last check before pushing: `git log --oneline $BQ_BASE..HEAD` shows 13 commits (step 1 to step 13). Then push the branch and open ONE PR;
its "Files changed" tab must list the 12 files above.

==========================================================================================
TYLER STEPS (Tyler only. The IDE never runs these.)
==========================================================================================
MIGRATIONS: none. No Supabase schema change.
DATA DELETIONS / RE-JUDGE: none in this PR. Re-judging affected games needs Tyler's approval.
T1. SHIP BEFORE THE 10 PM CT MORNING RUN. If time is short, merge at least through group MC (steps 1-4) + BQ (steps 5-7); every group
is green on its own.
T2. OPTIONAL ENV (documented only; never changed by an agent): SWARM*STARTUP_BENCHMARK, server-only (Render → swarm service →
Environment; never a VITE* var). Leave it UNSET: the startup benchmark then makes zero OpenRouter calls. Set it to 1 only for a
one-off benchmark, then remove it.
T3. CONFIRM the copied judgments (read-only, Supabase SQL editor):
SELECT game_date, win_prob_home, fair_spread, fair_total, total_lean, count(_), min(judged_at), max(judged_at)
FROM game_judgments WHERE game_date IN ('2026-10-15','2026-10-16') AND judge_source='swarm'
GROUP BY 1,2,3,4,5 ORDER BY count(_) DESC; -- expect big identical groups (Code Auditor: 36 of 37 = TB@CLE)
Re-judging affected games needs Tyler's approval. Any re-judge or delete would get its own plan with a backup command first.
T4. AFTER DEPLOY / after tonight's 10 PM CT run (read-only): Render logs show provider calls per game (Groq for the judge) and NO
"Semantic baseline cache hit" during the morning run; startup logs show "[Benchmark] Startup benchmark is off"; no openrouter.ai
call during the morning run. Re-run T3 for the new date: rows should differ per game.

==========================================================================================
GAPS (for Architect / Tyler)
==========================================================================================
G1. No runbook entry for this work; written from Manager's request + Navigator steering.
G2. Semantic-cache hardening (scope the key by game/caller, raise the 0.80 threshold, cachingPipeline.ts:97) NOT included: it changes AI Lab
caching and isn't safe tonight. bypassCache fixes the morning path fully.
G3. Qdrant Bad Request in learning-persistence.ts (~L150-172, string point IDs; unverified): already fixed by Phase F F-S2 (point IDs via
uuidv5, learning-persistence.ts:23/:32 on the end state). No group added. Still unverified live; check Render logs after Phase F deploys.
G4. DuelOdds still sends nemotron-3-ultra (AI Lab defaults) and has its own cloudflare/src/morningJudgments.ts:164, docs and memory-bank
references. DuelOdds-side; step 12's alias covers whatever reaches this swarm.
G5. Morning analysts on Groq keep the 6k-char groqMode 'morning' cap (analystExecution.ts line sits inside round 2's BEFORE block).
G6. Up to three Groq seats share the 7k tokens/min budget; when Groq is busy the judge falls back to gemini/mistral (never OpenRouter).
G7. buildDefaultAgents' doc and critic still name OpenRouter; the engine remaps them on morning runs, and Phase F swaps the critic model.
G8. When SWARM_STARTUP_BENCHMARK is on, the benchmark still runs at every boot plus every 24h (about 3 calls, 1 OpenRouter).
G9. Smoke sha drift: main carries the reformatted smoke (9ffcb9d…), other files quote 594928…; step 1 is an empty commit either way.
