# IDE RUN-THROUGH: The Perfect Swarm, R3-S1 hotfix: morning run dedupe (delete the Render cron, single-flight /api/swarm/morning, judge only unjudged + unclaimed games)

Repo: tbreauxai/The_Perfect_Swarm
Base: CURRENT main = 796d8e423742db931da2ecca6a09909a85145898
"fix" (TylerB, 2026-10-16 2:15 PM CT; fetched ~2:25 PM CT; live on Render). It rewrites the TypeScript parameter properties in
src/swarm/providers/limiter.ts as plain fields (round 1's Render boot crash under Node 22 strip-only mode), on top of dbce906
(todo.md only) and d052bee (round 1, PR #91). This hotfix does NOT depend on round 2 (ide_perfect_swarm_round2_scorecards.txt) or on
the snapshots/feedback hotfix. The files it touches are byte-identical in 796d8e4, dbce906, d052bee and 34b0eb8, so every BEFORE
block and line number below matches all of them (re-checked against 796d8e4). Ship it now.
Revision: v2 (Oct 16 ~2:30 PM CT): re-anchored to 796d8e4, strip-types scan, new step 11 startup smoke test. v1 is kept as
ide_perfect_swarm_morning_dedupe.v1.txt. Steps 1-10 are unchanged.
Strip-types check (Oct 16 ~2:30 PM CT): every AFTER block was scanned for syntax Node 22's --experimental-strip-types rejects (parameter
properties, enums, namespaces, `import x = require`, decorators, angle-bracket assertions; i.e. tsc --erasableSyntaxOnly) and for
type-only imports without `import type` (tsc --verbatimModuleSyntax). Result: none found, nothing to fix. The final step boots the real
Render start command to prove it.
Source: Architect "Architecture Plan: round 3, swarm side (2026-10-16 ~2:05 PM CT)", section R3-S1, in audit_runbook_perfect_swarm.md
(sole source of scope). Tyler approved: delete the Render cron, single-flight on /api/swarm/morning, judge only unjudged + unclaimed games,
and leave the DuelOdds Cloudflare Worker trigger (worker.ts:139-146) untouched.
Branch: create a NEW branch from main, e.g. `fix/morning-dedupe`.
Steps: 11 (R3-S1.1 cron removal: 3, R3-S1.2 single-flight + dedupe: 6, R3-S1.3 tests: 1, startup smoke test: 1). 11 commits.
10 files (1 new source, 1 new test, 1 new smoke script shared with the other PS IDE files, 1 deleted, 6 edited). No DB migration (the plan's in-process option), no env var changes, no Worker changes.
Plan order: the cron removal (group 1) comes first and can deploy on its own; the lock and dedupe (group 2) follow, as R3-S1.4 says. One PR.
Design calls (where the plan left a choice):
(1) Lock and claims are in-process (module level), per "an in-process lock; Render free runs one instance". Navigator checked Render
read-only: the service runs on the free plan with numInstances 1. No KV or DB claim table, so no migration.
(2) Claim = "<gameDate>|<eventId>" with a timestamp, kept 20 minutes. Games are claimed after the Supabase partition and BEFORE any LLM call.
Only the HTTP route passes the shared claim store; direct runMorningSlate() callers behave exactly as before.
(3) "Judge only games with no judgment today": a swarm row for today is never redone. The one exception: an `awaiting_lines` row is
re-judged once, when the scoreboard has lines. Before this, awaiting_lines games were re-judged on every trigger.
DECISION FOR TYLER: to never re-judge awaiting_lines at all, drop `|| !game.oddsSnapshot` in step 7b.
(4) The 202 body is exactly {status:'already_running'}. The finished run's 200 body gains `skippedClaimed`.

## HOW TO RUN THIS (one continuous pass)

Do every step from 1 to 11 in one go. Don't stop to submit, report, or open a PR between steps or groups. There's one branch and one PR at the very end.

1. On up-to-date main (`git pull`), note the base: `R3_BASE=$(git rev-parse HEAD)` (expected 796d8e423742db931da2ecca6a09909a85145898, or newer).
   Then `git checkout -b fix/morning-dedupe`.
   Never commit to main.
2. After each step passes its Acceptance line, run `git add -A && git commit -m 'step N'` and go straight to the next step.
3. At the end of each group, run the GROUP CHECK shown there. If it's green, keep going.
4. After step 11, run FINAL VERIFICATION once, then push the branch and open a single PR.
5. Never run: git reset (soft or hard), git checkout ., git restore, git clean, git rebase, or any squash. Tyler squashes on merge.
6. Never apply a migration and never change Render env vars. This hotfix needs neither.

## HOW TO READ THE STEPS

- Line numbers are from the base above. Earlier steps shift later lines in the same file (README.md, morning/index.ts), so find each edit by its
  BEFORE text and replace it with the AFTER text. The text is what counts.
- "NEW FILE" means create the file with exactly that content. "DELETE FILE" means run the git rm command shown.
- README.md blocks are fenced with ~~~ because the README itself contains ``` blocks. Copy only what's between the ~~~ lines.
- Don't refactor, rename or reformat anything outside the quoted blocks.

==========================================================================================
R3-S1.1: DELETE THE RENDER CRON (can deploy on its own)
==========================================================================================

## STEP 1: remove the Render cron service, in render.yaml

(render.yaml ends right after the web service's MISTRAL_API_KEY entry (keep one trailing newline). The web service block (lines 1-28) is unchanged.)
1a. Delete lines 29-42: the blank line and the whole `type: cron` service (the plan cites 30-35, but the block runs to 42 with its envVars). The BEFORE starts at line 27 as an anchor, at render.yaml:27-42
BEFORE:

```yaml
      - key: MISTRAL_API_KEY
        sync: false

  - type: cron
    name: swarm-morning-slate
    env: node
    schedule: "0 11 * * *" # Daily 11:00 UTC = 06:00 AM America/Chicago
    buildCommand: npm install
    startCommand: "node scripts/morning-cron.mjs"
    envVars:
      - key: NODE_ENV
        value: production
      - key: SWARM_BASE_URL
        value: https://the-perfect-swarm.onrender.com
      - key: SWARM_APP_TOKEN
        sync: false
```

AFTER:

```yaml
- key: MISTRAL_API_KEY
  sync: false
```

Acceptance: `git grep -n "type: cron\|morning-cron" -- render.yaml` prints nothing, and render.yaml still declares the `the-perfect-swarm` web service with all 10 env vars.

## STEP 2: DELETE FILE scripts/morning-cron.mjs

(Run `git rm scripts/morning-cron.mjs`. Nothing imports it: its only references were render.yaml (step 1) and README.md (step 3). There's no package.json script for it.)
Command:

```sh
git rm scripts/morning-cron.mjs
```

Acceptance: `test ! -e scripts/morning-cron.mjs` succeeds and `git grep -n "morning-cron"` only matches README.md (fixed in step 3) and .omg/ultragoal/ledger.jsonl (history log, left as is).

## STEP 3: docs: the Worker is the only scheduler, in README.md

(These README blocks are fenced with ~~~ instead of `because the text itself contains a`yaml block.)
3a. Intro sentence, at README.md:299
BEFORE:

```markdown
The Render service directly owns the daily morning slate. A single API call or Render cron trigger executes the full end-to-end pipeline:
```

AFTER:

```markdown
The Render service directly owns the daily morning slate. A single API call executes the full end-to-end pipeline; the DuelOdds Cloudflare Worker is the only scheduler (see Scheduling below):
```

3b. Replace the "Render Cron Configuration" section, at README.md:326-337
BEFORE:

````markdown
### Render Cron Configuration

A Render cron service is declared in `render.yaml` to trigger the morning slate daily at 6:00 AM Central (`0 11 * * *` UTC) with no 50-call cap:

```yaml
- type: cron
  name: swarm-morning-slate
  env: node
  schedule: "0 11 * * *"
  buildCommand: npm install
  startCommand: "node scripts/morning-cron.mjs"
```
````

AFTER:

```markdown
### Scheduling

The DuelOdds Cloudflare Worker's cron trigger (`*/20 3-12`, UTC) is the only scheduler; it calls `POST /api/swarm/morning` every 20 minutes from 03:00 to 12:40 UTC. There is no Render cron service (removed in R3-S1 because it doubled the 11:00 UTC run). Single-flight plus the per-game dedupe make repeated triggers cheap: games already judged today are skipped.
```

Acceptance: `git grep -n "morning-cron\|Render cron" -- README.md` prints nothing.

GROUP CHECK (R3-S1.1 done): `npm run lint && npm run test:unit`, and `git grep -n "morning-cron\|type: cron" -- render.yaml README.md scripts package.json` prints nothing. If it's green, continue straight to the next group without stopping.

==========================================================================================
R3-S1.2: SINGLE-FLIGHT + JUDGE ONLY UNJUDGED, UNCLAIMED GAMES
==========================================================================================

## STEP 4: NEW FILE src/swarm/morning/singleFlight.ts

(In-process lock + 20-minute claim map, per the plan ("an in-process lock; Render free runs one instance"; "a claim timestamp on the job or in KV/DB": this uses the on-the-job option). No DB table, no KV, no migration.)
AFTER (new file):

```ts
/**
 * R3-S1 morning dedupe (hotfix for doubled LLM cost).
 * In-process only, per the plan: Render runs ONE instance of the web service, so a module-level lock and a
 * claim map are enough. No DB/KV table and no migration. If the service is ever scaled past one instance,
 * this must move to a DB/KV claim (see the deploy notes).
 */

/** A game claimed by a run is skipped by any other run for 20 minutes (one Worker trigger interval). */
export const MORNING_CLAIM_TTL_MS = 20 * 60 * 1000;

let morningRunInFlight = false;

/** Returns true and takes the lock if no morning run is in flight; false if one already is. */
export function tryAcquireMorningLock(): boolean {
  if (morningRunInFlight) return false;
  morningRunInFlight = true;
  return true;
}

export function releaseMorningLock(): void {
  morningRunInFlight = false;
}

export function isMorningRunInFlight(): boolean {
  return morningRunInFlight;
}

export interface MorningClaimStore {
  /** True if the key was claimed less than the TTL ago. */
  isClaimed(key: string, now?: number): boolean;
  /** Records a claim at `now` (defaults to Date.now()). */
  claim(key: string, now?: number): void;
}

export function morningClaimKey(gameDate: string, eventId: string): string {
  return `${gameDate}|${eventId}`;
}

export function createMorningClaimStore(
  ttlMs: number = MORNING_CLAIM_TTL_MS,
): MorningClaimStore & { size(): number; clear(): void } {
  const claims = new Map<string, number>();
  const prune = (now: number) => {
    for (const [key, at] of claims) {
      if (now - at >= ttlMs) claims.delete(key);
    }
  };
  return {
    isClaimed(key: string, now: number = Date.now()): boolean {
      prune(now);
      const at = claims.get(key);
      return at !== undefined && now - at < ttlMs;
    },
    claim(key: string, now: number = Date.now()): void {
      claims.set(key, now);
    },
    size(): number {
      return claims.size;
    },
    clear(): void {
      claims.clear();
    },
  };
}

/** The claim store POST /api/swarm/morning passes to runMorningSlate. */
export const morningClaims = createMorningClaimStore();

/** Test helper: drop the lock and every claim. */
export function resetMorningSingleFlight(): void {
  morningRunInFlight = false;
  morningClaims.clear();
}
```

Acceptance: `npm run lint` passes.

## STEP 5: skippedClaimed on the batch result, in src/swarm/morning/types.ts

5a. MorningBatchResult, at src/swarm/morning/types.ts:71-72
BEFORE:

```ts
skipped: number;
snapshots: number;
```

AFTER:

```ts
  skipped: number;
  /** R3-S1: games skipped because another run claimed them in the last 20 minutes. */
  skippedClaimed?: number;
  snapshots: number;
```

Acceptance: `npm run lint` passes.

## STEP 6: runMorningSlate judges only unclaimed games (claims taken before any LLM call), in src/swarm/morning/index.ts

(With no `claims` option (direct library callers, existing tests) the behavior is exactly as before; only the HTTP route passes the shared store. A claim is kept for 20 minutes even if the game errors, so a failed game is retried on a later trigger instead of every overlapping run.)
6a. Import, at src/swarm/morning/index.ts:18-19
BEFORE:

```ts
import type { MorningBatchResult, SlateGame } from "./types.ts";
import { executeSwarmWorkflow } from "../engine/index.ts";
```

AFTER:

```ts
import type { MorningBatchResult, SlateGame } from "./types.ts";
import { morningClaimKey, type MorningClaimStore } from "./singleFlight.ts";
import { executeSwarmWorkflow } from "../engine/index.ts";
```

6b. Re-export, at src/swarm/morning/index.ts:25-26
BEFORE:

```ts
export * from "./feedback.ts";
```

AFTER:

```ts
export * from "./feedback.ts";
export * from "./singleFlight.ts";
```

6c. Options, at src/swarm/morning/index.ts:87-88
BEFORE:

```ts
  executeWorkflowFn?: typeof executeSwarmWorkflow;
}
```

AFTER:

```ts
  executeWorkflowFn?: typeof executeSwarmWorkflow;
  /** R3-S1: skip games claimed by another run in the last 20 minutes, and claim the rest. The route passes morningClaims. */
  claims?: MorningClaimStore;
  /** Clock for claims (tests). */
  now?: () => number;
}
```

6d. Destructure, at src/swarm/morning/index.ts:106-107
BEFORE:

```ts
    executeWorkflowFn = executeSwarmWorkflow
  } = options;
```

AFTER:

```ts
    executeWorkflowFn = executeSwarmWorkflow,
    claims,
    now = Date.now
  } = options;
```

6e. Claim filter, right after gamesToProcess, at src/swarm/morning/index.ts:156-158
BEFORE:

```ts
    ...gamesToJudge.map((g) => ({ game: g, isReplace: false }))
  ];

```

AFTER:

```ts
    ...gamesToJudge.map((g) => ({ game: g, isReplace: false }))
  ];

  // R3-S1: judge only unclaimed games. A game claimed in the last 20 minutes is skipped; every other game is
  // claimed now, before any LLM call, so an overlapping run can't pick it up.
  let skippedClaimed = 0;
  const unclaimedGames = claims
    ? gamesToProcess.filter(({ game }) => {
        const key = morningClaimKey(gameDate, game.eventId);
        if (claims.isClaimed(key, now())) {
          skippedClaimed++;
          return false;
        }
        claims.claim(key, now());
        return true;
      })
    : gamesToProcess;

```

6f. Loop, at src/swarm/morning/index.ts:173
BEFORE:

```ts
  for (const item of gamesToProcess) {
```

AFTER:

```ts
  for (const item of unclaimedGames) {
```

6g. Result, at src/swarm/morning/index.ts:266-270
BEFORE:

```ts
    skipped: skippedCount,
    snapshots: snapshotsCount,
    errors,
    settled: settledCount
  };
```

AFTER:

```ts
    skipped: skippedCount,
    skippedClaimed,
    snapshots: snapshotsCount,
    errors,
    settled: settledCount
  };
```

Acceptance: `npm run lint` passes and `npx vitest run src/swarm/server/morning.test.ts` passes unchanged.

## STEP 7: a swarm judgment today is never redone (awaiting_lines only once lines arrive), in src/swarm/morning/supabase.ts

(Before this, a swarm row with status awaiting_lines was re-judged on EVERY trigger (up to 29 times a night) even when the scoreboard still had no lines. Direct/null-source rows are still replaced as before.)
7a. Doc comment, at src/swarm/morning/supabase.ts:54-55
BEFORE:

```ts
 * - gamesToReplace: games with direct/null judge_source or awaiting_lines
 * - skippedCount: games already judged by swarm
```

AFTER:

```ts
 * - gamesToReplace: games with direct/null judge_source, or a swarm awaiting_lines row whose lines have now arrived
 * - skippedCount: games already judged by swarm today (R3-S1: including awaiting_lines rows while there are still no lines)
```

7b. Partition rule, at src/swarm/morning/supabase.ts:106-107
BEFORE:

```ts
    } else if (existing.judge_source === 'swarm' && existing.status !== 'awaiting_lines') {
      skippedCount++;
```

AFTER:

```ts
    } else if (existing.judge_source === 'swarm' && (existing.status !== 'awaiting_lines' || !game.oddsSnapshot)) {
      // R3-S1: a swarm judgment today is never redone. The one exception is an awaiting_lines row once the
      // scoreboard has lines (re-judged once; the new row is 'judged'). Before, awaiting_lines games were re-judged every run.
      skippedCount++;
```

Acceptance: `npm run lint` passes and `npx vitest run src/swarm/server/morning.test.ts` passes unchanged.

## STEP 8: single-flight on POST /api/swarm/morning, in src/swarm/server/app.ts

(The lock is taken before any await, so two requests can't both get in. `finally` always releases it, including on errors. Auth still runs first (app-level middleware), so an unauthenticated call never touches the lock.)
8a. Import, at src/swarm/server/app.ts:28
BEFORE:

```ts
import { runMorningSlate } from "../morning/index.ts";
```

AFTER:

```ts
import {
  runMorningSlate,
  tryAcquireMorningLock,
  releaseMorningLock,
  morningClaims,
} from "../morning/index.ts";
```

8b. Route, at src/swarm/server/app.ts:304-317
BEFORE:

```ts
app.post("/api/swarm/morning", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const env = Object.assign(
      {},
      typeof process !== "undefined" ? process.env : {},
      c.env || {},
    ) as Record<string, any>;
    const result = await runMorningSlate({
      dateInput: body?.date,
      env,
    });
    return c.json(result, 200);
  } catch (err: any) {
    console.error("[SwarmServer Morning Slate Error]:", err);
    return c.json({ error: err.message || "Internal Server Error" }, 500);
  }
});
```

AFTER:

```ts
app.post("/api/swarm/morning", async (c) => {
  // R3-S1: single-flight. A second call while a run is in flight returns 202 and does no work.
  if (!tryAcquireMorningLock()) {
    return c.json({ status: "already_running" }, 202);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const env = Object.assign(
      {},
      typeof process !== "undefined" ? process.env : {},
      c.env || {},
    ) as Record<string, any>;
    const result = await runMorningSlate({
      dateInput: body?.date,
      env,
      claims: morningClaims,
    });
    return c.json(result, 200);
  } catch (err: any) {
    console.error("[SwarmServer Morning Slate Error]:", err);
    return c.json({ error: err.message || "Internal Server Error" }, 500);
  } finally {
    releaseMorningLock();
  }
});
```

Acceptance: `npm run lint` passes and `npm run test:unit` passes.

## STEP 9: docs: single-flight and dedupe on the endpoint, in README.md

9a. Endpoint spec, at README.md:311-312
BEFORE:

```markdown
- **Body** (optional): `{ "date": "YYYY-MM-DD" }` (defaults to today in `America/Chicago`)
- **Response**:
```

AFTER:

```markdown
- **Body** (optional): `{ "date": "YYYY-MM-DD" }` (defaults to today in `America/Chicago`)
- **Single-flight**: only one run at a time. A call that arrives while a run is in flight returns `202 {"status":"already_running"}` and does no work.
- **Dedupe**: each run judges only games with no swarm judgment today (an `awaiting_lines` row is re-judged once, when lines arrive) and skips games another run claimed in the last 20 minutes (`skippedClaimed`).
- **Response**:
```

9b. Example response, at README.md:319-320
BEFORE:

```markdown
"skipped": 5,
"snapshots": 16,
```

AFTER:

```markdown
"skipped": 5,
"skippedClaimed": 0,
"snapshots": 16,
```

Acceptance: README renders; the endpoint section mentions 202 already_running and skippedClaimed.

GROUP CHECK (R3-S1.2 done): `npm run lint && npm run test:unit`. If it's green, continue straight to the next group without stopping.

==========================================================================================
R3-S1.3: TESTS
==========================================================================================

## STEP 10: NEW FILE src/swarm/server/morningDedupe.test.ts (two concurrent calls = one run; judged game not re-judged; claims; awaiting_lines; cron removed)

AFTER (new file):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createSwarmServer } from "./app.ts";
import {
  runMorningSlate,
  partitionSlateGames,
  createMorningClaimStore,
  morningClaimKey,
  resetMorningSingleFlight,
  isMorningRunInFlight,
  MORNING_CLAIM_TTL_MS,
  type SlateGame,
} from "../morning/index.ts";

const JUDGE_OK = {
  workflowId: "wf-dedupe",
  finalAnalysis: JSON.stringify({
    likelyWinner: "Cowboys",
    winProbHome: 0.6,
    winProbAway: 0.4,
    fairSpread: -3.0,
    fairTotal: 48.0,
    totalLean: "none",
    arguments: [],
  }),
};

const espnEvent = (id: string, withOdds = true) => ({
  id,
  date: "2026-10-15T18:00:00Z",
  competitions: [
    {
      competitors: [
        { homeAway: "home", team: { displayName: `Home ${id}` } },
        { homeAway: "away", team: { displayName: `Away ${id}` } },
      ],
      ...(withOdds
        ? { odds: [{ details: "HOME -3.0", spread: -3.0, overUnder: 48.0 }] }
        : {}),
    },
  ],
});

/** ESPN returns the given NFL events; Supabase returns `rows` for the game_judgments read and accepts writes. */
function slateFetch(events: any[], rows: any[] = []): typeof fetch {
  return vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/sports/football/nfl/")) {
      return new Response(JSON.stringify({ events }), { status: 200 });
    }
    if (u.includes("apis/site/v2/sports/")) {
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }
    if (u.includes("game_judgments?game_date=")) {
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (u.includes("line_snapshots?")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(null, { status: 201 });
  }) as any;
}

const SUPABASE_ENV = {
  GEMINI_API_KEY: "test-gemini-key",
  SUPABASE_URL: "https://mock.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "mock-service-key",
};

describe("R3-S1 morning dedupe", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetMorningSingleFlight();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetMorningSingleFlight();
    vi.restoreAllMocks();
  });

  describe("POST /api/swarm/morning single-flight", () => {
    let app: any;

    beforeEach(() => {
      const baseApp = createSwarmServer({
        defaultSettings: { appId: "duelodds" },
      });
      app = new Hono();
      app.use("*", async (c: any, next: any) => {
        c.set("callerAppId", "duelodds");
        c.env = {
          SWARM_APP_TOKENS: "duelodds:test-token-123",
          SWARM_AUTH_REQUIRED: "true",
          GEMINI_API_KEY: "test-gemini-key",
        };
        await next();
      });
      app.route("/", baseApp);
    });

    const post = () =>
      app.fetch(
        new Request("http://localhost/api/swarm/morning", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-token-123",
          },
          body: JSON.stringify({ date: "2026-10-15" }),
        }),
      );

    it('two concurrent calls lead to one run: the second gets 202 {status:"already_running"} and does no work', async () => {
      let releaseEspn!: () => void;
      const espnGate = new Promise<void>((r) => {
        releaseEspn = r;
      });
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes("apis/site/v2/sports/")) {
          await espnGate;
          return new Response(JSON.stringify({ events: [] }), { status: 200 });
        }
        return new Response(null, { status: 200 });
      });
      globalThis.fetch = fetchMock as any;

      const first = post();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(isMorningRunInFlight()).toBe(true);
      const espnCallsWhileRunning = fetchMock.mock.calls.length;

      const second = await post();
      expect(second.status).toBe(202);
      expect(await second.json()).toEqual({ status: "already_running" });
      // The rejected call started no slate fetches of its own.
      expect(fetchMock.mock.calls.length).toBe(espnCallsWhileRunning);

      releaseEspn();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      expect((await firstRes.json()).ok).toBe(true);
      expect(isMorningRunInFlight()).toBe(false);
    });

    it("releases the lock after a run, so the next call runs normally", async () => {
      globalThis.fetch = vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ events: [] }), { status: 200 }),
        ) as any;
      expect((await post()).status).toBe(200);
      expect(isMorningRunInFlight()).toBe(false);
      expect((await post()).status).toBe(200);
    });
  });

  describe("judge only unjudged, unclaimed games", () => {
    it("a game already judged today is not judged again", async () => {
      const executeWorkflowFn = vi.fn().mockResolvedValue(JUDGE_OK);
      const result = await runMorningSlate({
        dateInput: "2026-10-15",
        env: SUPABASE_ENV,
        fetchFn: slateFetch(
          [espnEvent("g1"), espnEvent("g2")],
          [{ event_id: "nfl-g1", judge_source: "swarm", status: "judged" }],
        ),
        executeWorkflowFn,
        claims: createMorningClaimStore(),
      });
      expect(executeWorkflowFn).toHaveBeenCalledTimes(1);
      expect(executeWorkflowFn.mock.calls[0][0].task).toContain("Home g2");
      expect(result.skipped).toBe(1);
      expect(result.judged).toBe(1);
    });

    it("a game claimed in the last 20 minutes is skipped; after 20 minutes it can be judged again", async () => {
      const claims = createMorningClaimStore();
      let clock = 1_000_000;
      const now = () => clock;
      const failing = vi.fn().mockRejectedValue(new Error("provider 429"));
      const fetchFn = slateFetch([espnEvent("g1")]);

      const run1 = await runMorningSlate({
        dateInput: "2026-10-15",
        env: SUPABASE_ENV,
        fetchFn,
        executeWorkflowFn: failing,
        claims,
        now,
      });
      expect(failing).toHaveBeenCalledTimes(1);
      expect(run1.errors.map((e) => e.eventId)).toEqual(["nfl-g1"]);
      expect(
        claims.isClaimed(morningClaimKey("2026-10-15", "nfl-g1"), clock),
      ).toBe(true);

      clock += MORNING_CLAIM_TTL_MS - 1;
      const ok = vi.fn().mockResolvedValue(JUDGE_OK);
      const run2 = await runMorningSlate({
        dateInput: "2026-10-15",
        env: SUPABASE_ENV,
        fetchFn,
        executeWorkflowFn: ok,
        claims,
        now,
      });
      expect(ok).not.toHaveBeenCalled();
      expect(run2.skippedClaimed).toBe(1);

      clock += 1;
      const run3 = await runMorningSlate({
        dateInput: "2026-10-15",
        env: SUPABASE_ENV,
        fetchFn,
        executeWorkflowFn: ok,
        claims,
        now,
      });
      expect(ok).toHaveBeenCalledTimes(1);
      expect(run3.judged).toBe(1);
      expect(run3.skippedClaimed).toBe(0);
    });

    it("without a claim store (direct library callers) every unjudged game is processed as before", async () => {
      const executeWorkflowFn = vi.fn().mockResolvedValue(JUDGE_OK);
      const fetchFn = slateFetch([espnEvent("g1")]);
      await runMorningSlate({
        dateInput: "2026-10-15",
        env: { GEMINI_API_KEY: "k" },
        fetchFn,
        executeWorkflowFn,
      });
      await runMorningSlate({
        dateInput: "2026-10-15",
        env: { GEMINI_API_KEY: "k" },
        fetchFn,
        executeWorkflowFn,
      });
      expect(executeWorkflowFn).toHaveBeenCalledTimes(2);
    });

    it("awaiting_lines swarm rows: skipped while there are still no lines, re-judged once lines arrive", async () => {
      const cfg = {
        supabaseUrl: "https://mock.supabase.co",
        supabaseServiceKey: "k",
      };
      const game = (eventId: string, withOdds: boolean): SlateGame => ({
        eventId,
        sport: "americanfootball_nfl",
        league: "nfl",
        homeTeam: "H",
        awayTeam: "A",
        commenceTime: "2026-10-15T18:00:00Z",
        gameDate: "2026-10-15",
        weatherSnapshot: null,
        oddsSnapshot: withOdds
          ? { details: "H -3.0", spread: -3.0, overUnder: 48.0 }
          : null,
      });
      const rows = [
        {
          event_id: "nfl-nolines",
          judge_source: "swarm",
          status: "awaiting_lines",
        },
        {
          event_id: "nfl-lines",
          judge_source: "swarm",
          status: "awaiting_lines",
        },
      ];
      const { gamesToJudge, gamesToReplace, skippedCount } =
        await partitionSlateGames(
          cfg,
          [game("nfl-nolines", false), game("nfl-lines", true)],
          "2026-10-15",
          slateFetch([], rows),
        );
      expect(skippedCount).toBe(1);
      expect(gamesToReplace.map((g) => g.eventId)).toEqual(["nfl-lines"]);
      expect(gamesToJudge).toEqual([]);
    });
  });

  describe("Render cron removed", () => {
    it("render.yaml has no cron service and scripts/morning-cron.mjs is gone", () => {
      const yaml = readFileSync(resolve(process.cwd(), "render.yaml"), "utf8");
      expect(yaml).not.toMatch(/type:\s*cron/);
      expect(yaml).not.toContain("morning-cron");
      expect(
        existsSync(resolve(process.cwd(), "scripts/morning-cron.mjs")),
      ).toBe(false);
    });
  });
});
```

Acceptance: `npx vitest run src/swarm/server/morningDedupe.test.ts` passes (7 tests).

# GROUP CHECK (R3-S1.3 done): `npx vitest run src/swarm/server/morningDedupe.test.ts src/swarm/server/morning.test.ts`. If it's green, continue straight to step 11 (startup smoke test).

# SMOKE: STARTUP SMOKE TEST (the real Render start command)

## STEP 11: NEW FILE scripts/smoke-start.mjs (boot the server with the Dockerfile CMD and hit /api/health)

(Why: round 1 (#91) passed lint, unit tests, the simulation and the build, then crashed on Render at boot. Render runs the Docker image, whose CMD
is `node --experimental-strip-types server.ts`, and Node 22's strip-only mode rejected the TypeScript parameter properties in
src/swarm/providers/limiter.ts:31 (fixed in 796d8e4). tsc and vitest/esbuild accept that syntax, so only booting the real start command catches it.
This script reads the CMD from the Dockerfile (so it always runs what Render runs), starts it with NODE_ENV=production, PORT=3999 and a stub
SWARM_APP_TOKENS, and no provider keys (so no outbound calls), polls GET /api/health until it returns 200 {"status":"ok"}, stops the server and
exits 0. If the server exits early or never gets healthy, it prints the server log and exits 1.
Shared file: the other Perfect Swarm IDE files (hotfix_snapshots_feedback, morning_dedupe, round2_scorecards) add this SAME file with
byte-identical content. If scripts/smoke-start.mjs already exists with exactly this content, leave it as is and commit with --allow-empty
(identical adds also merge cleanly in git). It's a plain .mjs script outside tsconfig, so lint doesn't type-check it.)
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

Run (production mode serves ./dist, so build first):

```sh
npm run build && node scripts/smoke-start.mjs
```

Commit: `git add -A && git commit --allow-empty -m 'step 11'` (--allow-empty only matters if the identical file was already on main).
Acceptance: the script prints `[smoke] start command (Dockerfile CMD): node --experimental-strip-types server.ts`,
`[smoke] GET /api/health -> 200 {"status":"ok","edge":true}` and `[smoke] PASS`, and exits 0. On FAIL, a `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]`
line in the printed server log names the file and syntax to rewrite (for example parameter properties as plain fields assigned in the constructor).

==========================================================================================
FINAL VERIFICATION (run once, after step 11)
==========================================================================================
npm ci
npm run lint
npm run test:unit
npm run test:simulation
npm run build
node scripts/smoke-start.mjs (boots the Dockerfile CMD; must print [smoke] PASS and exit 0)
npx vitest run src/swarm/server/morningDedupe.test.ts src/swarm/server/morning.test.ts src/swarm/server/app.test.ts

Use Node >= 22 (vitest/jsdom need it).

Sanity greps (expected results):
git grep -n "type: cron" -- render.yaml → no match
test ! -e scripts/morning-cron.mjs && echo gone → gone
git grep -n "morning-cron" → only .omg/ultragoal/ledger.jsonl (history, left as is) and
src/swarm/server/morningDedupe.test.ts (asserts the file is gone)
git grep -n "tryAcquireMorningLock()" -- src/swarm/server/app.ts → 1 match
git grep -n "claims: morningClaims" -- src/swarm/server/app.ts → 1 match
git grep -n "for (const item of unclaimedGames)" -- src/swarm/morning/index.ts → 1 match

Expected `git diff --stat $R3_BASE` file list (10 files; nothing else; scripts/smoke-start.mjs is absent if main already had it):
render.yaml
scripts/morning-cron.mjs (deleted)
README.md
src/swarm/morning/singleFlight.ts (new)
src/swarm/morning/types.ts
src/swarm/morning/index.ts
src/swarm/morning/supabase.ts
src/swarm/server/app.ts
src/swarm/server/morningDedupe.test.ts (new)
scripts/smoke-start.mjs (new, shared; identical in the other PS IDE files)

Last check before pushing: `git log --oneline $R3_BASE..HEAD` shows 11 commits (step 1 to step 11), and `git diff --stat $R3_BASE` lists the files above.
Then push the branch and open ONE PR; its "Files changed" tab must not be empty.

## DEPLOY NOTES

- Render autodeploys main on commit after Tyler merges (squash). No env vars, no migrations, no Supabase changes, no DuelOdds/Worker changes.
- RENDER CRON SERVICE: Render Blueprints never delete a service that's removed from render.yaml. If a `swarm-morning-slate` cron service exists,
  Tyler deletes it by hand in the Render dashboard after merge (Dashboard → swarm-morning-slate → Settings → Delete Service). Delete it only
  after the merge, or a Blueprint sync would recreate it.
  Navigator's read-only check (Oct 16 ~2:05 PM CT): the workspace has ONE service, the `The_Perfect_Swarm` web service (Docker, free plan,
  1 instance), and NO cron service. Today's logs show one morning run at 11:00 UTC and the next at 11:20 UTC (the Worker cadence), with no
  overlapping run. So the cron entry was never live, and there's probably nothing to delete. Check the dashboard once anyway.
  The live service is not Blueprint-managed either: render.yaml declares a node/standard service named `the-perfect-swarm`.
- Single-flight is per process. Render's zero-downtime deploy briefly runs the old and new instance together, so a trigger that lands exactly during
  a deploy can still run twice. Free-plan spin-down or a restart clears the in-memory claims; the "already judged today" rule in Supabase still
  holds across restarts.
- If the service is ever scaled past 1 instance, move the lock and claims to Supabase (a claimed_at column or claim table needs a migration Tyler
  applies). Not needed now.
- The Worker keeps calling every 20 minutes from 03:00 to 12:40 UTC. Calls that overlap a running slate now get 202 {status:'already_running'};
  the Worker treats it as a 2xx. Later calls only judge new games, games whose awaiting_lines row now has lines, and games a failed run left
  unjudged once their 20-minute claim lapses.

## OVERLAP WITH ROUND 1 AND ROUND 2 (for an easy later merge)

- Round 1 is already on main (PR #91, merged 2:00 PM CT) plus Tyler's strip-types fix (796d8e4), and this file is based on that. No conflict.
- The snapshots/feedback hotfix (ide_perfect_swarm_hotfix_snapshots_feedback.txt) also edits src/swarm/morning/supabase.ts (insertBaselineLineSnapshots,
  179-237) and morning/index.ts (doc line 97); no shared hunks. Dry-run in both orders on 796d8e4: all BEFORE blocks matched once, all checks and the
  smoke test green. Both add the identical scripts/smoke-start.mjs; whichever runs second commits that step with --allow-empty.
- Files only this hotfix touches: render.yaml, scripts/morning-cron.mjs, README.md, src/swarm/morning/{singleFlight,types,index,supabase}.ts, and
  src/swarm/server/morningDedupe.test.ts. Neither round 1 nor round 2 touches them. agent.ts, engine/index.ts, analystExecution.ts, groq.ts
  and the other round 1/2 files are untouched here.
- The one shared file is src/swarm/server/app.ts:
  - R3 changes line 28 (morning import) and the /api/swarm/morning route (lines 304-317), net +7 lines (9 added, 2 changed).
  - Round 1 PS1 (already merged) edited the /analyze result block further down (~558).
  - Round 2 edits the stream/analyze params (~454 and ~545). Those are separate hunks, so they merge cleanly.
    If R3 lands first, round 2's app.ts lines move down by 7 (456-458 becomes 463-465, 547-549 becomes 554-556). Round 2 already says to find edits by BEFORE text.
- No behavior overlap: round 1 left Groq morning mode unchanged, and round 2 scorecard mode is off for responseSchema 'morning_judge'.
  The morning judge calls executeSwarmWorkflow exactly as before.
