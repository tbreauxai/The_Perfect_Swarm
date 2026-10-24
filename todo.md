IDE RUN-THROUGH: The Perfect Swarm, morning judge cross-check (DuelOdds live test 2026-10-24, bug 1, Swarm side S1-S4)

Base: main 31f9aaa "feat(swarm): eliminate failover cascades across provider tiers (PRD swarm zero failover)". Fetched 2026-10-24
~4:20 PM CT; main had NOT moved from 31f9aaa.
Source: /workspace/rootcause_duelodds_livetest_2026-10-24.md bug 1; /workspace/ide_duelodds_livetest_fixes.txt Swarm-side S1-S4.
Branch: create a NEW branch from up-to-date main: `fix/judge-crosscheck`.
Size: 6 steps = 6 commits, 3 groups. 5 files change (1 new, 4 edited) + the smoke empty commit. No migrations, no env changes.
SM step 1 shared startup smoke (already on main → empty commit)
JP steps 2-4 judgePrompt.ts: cross-check helper (S1), wired into the parser with the sport range replacing "> 0" (S2),
NCAAF/NCAAB ranges (S3), sport-neutral fairTotal examples (S4)
DS steps 5-6 downstream: market lines passed in, error text, fixtures, new tests

WHAT IS REJECTED (parseAndValidateJudgeOutput returns null and logs `[MorningJudge] Rejected judgment for AWAY @ HOME: <reason>`)

- fairSpread sign vs winProbHome: spread > 0 (away favored, home perspective) with winProbHome > 0.5, or spread < 0 with winProbHome < 0.5.
- likelyWinner vs winProbHome: the named home team with winProbHome < 0.5, or the named away team with winProbHome > 0.5.
  (Live examples: LSU @ Auburn, away winner + 0.88 + -16.5; Miami OH @ CMU, 0.57 + +3.5.)
- |fairSpread - market spread| > 10, |fairTotal - market total| > 12 (the DuelOdds MODEL_DISAGREEMENT_CAPS; both spreads home perspective).
- fairTotal outside the sport range (DuelOdds SPORT_TOTAL_SANITY_RANGES, mirrored exactly: NFL 30-65, NCAAF 30-80, NBA 190-260,
  NCAAB 110-180, WNBA 130-190, MLB 5-14, NCAA baseball 5-18, NHL 4-8; unknown sport → no range check) or <= 0. A null/missing total is
  still accepted (the prompt allows null). Exactly 0.5 with any spread is accepted.
  DOWNSTREAM OF A REJECTION (verified on 31f9aaa, morning/index.ts ~243-257, tested in step 6)
- errors.push + continue, before computeModelSnapshot and upsertGameJudgment: nothing is written, no half-written game. The per-game
  try/catch is unchanged, the run goes on to the next game and returns ok=false with the error. No retry or fallback judge (by design).
  The game stays claimed for MORNING_CLAIM_TTL_MS (20 min); the next run re-judges it.

STRIP-TYPES CHECK (Render runs `node --experimental-strip-types server.ts`, Node 22)

- Erasable TypeScript only (no parameter properties, enums, namespaces, `import =`, decorators). Node stripTypeScriptTypes: 363 files,
  0 non-erasable. tsc --erasableSyntaxOnly --verbatimModuleSyntax: the 10 pre-existing errors only, none in a changed file.

## HOW TO RUN THIS (one continuous pass)

Do steps 1 to 6 in one go. Don't stop to submit, report or open a PR between steps or groups. One branch, one PR at the very end.

1. `git pull` on main. `JC_BASE=$(git rev-parse HEAD)` (expect 31f9aaa or later) and `git checkout -b fix/judge-crosscheck`. Node >= 22.
2. After each step passes its Acceptance line, commit with the exact `git add <files>` command shown (NOT `git add -A`: `npm run build`
   deletes 39 tracked files under .swarm-dts-staging/ in the working tree, and those deletions must never be committed).
3. At the end of each group run its GROUP CHECK. If green, keep going.
4. After step 6 run FINAL VERIFICATION once, then push the branch and open a single PR.
5. Never run: git reset (soft or hard), git checkout ., git restore, git clean, git rebase, or any squash. Tyler squashes on merge.
6. No migrations (none here) and no Render env changes (none needed).
7. Tests never hit the network: the new test injects fetch and executeWorkflowFn.

## HOW TO READ THE STEPS

- Find each edit by its BEFORE text (it matches exactly once at that point) and replace it with AFTER. Line numbers are those at the time of
  the step: step 3's are after step 2's insert (on main 31f9aaa they are 287, 327-332, 340-345); every other number is main's.
- "NEW FILE" means create the file with exactly that content. Don't refactor or reformat anything outside the quoted blocks.

==========================================================================================
STEP 1: shared startup smoke (scripts/smoke-start.mjs is already on main 31f9aaa: EMPTY commit)

---

No file changes. `scripts/smoke-start.mjs` is already on main 31f9aaa (`git ls-files scripts/smoke-start.mjs` prints it).
Commit: `git commit --allow-empty -m "step 1"`.
Acceptance: `git ls-files scripts/smoke-start.mjs` prints one line; `git log -1 --format=%s` is `step 1`.

GROUP CHECK (SM done): `npm run lint && git log -1 --format=%s`. If it's green, continue straight to the next group without stopping.

==========================================================================================
STEP 2: cross-check helpers: sport total ranges, market caps, crossCheckJudgeOutput (S1), in src/swarm/morning/judgePrompt.ts

---

(Ranges and caps are copied from DuelOdds (src/utils/meritVerdict.ts SPORT_TOTAL_SANITY_RANGES and MODEL_DISAGREEMENT_CAPS {spread: 10, total: 12}). Spreads are HOME perspective on both sides. The helper is not called yet; step 3 wires it in.)
2a. helpers, inserted just above the parseAndValidateJudgeOutput doc comment, at src/swarm/morning/judgePrompt.ts:275-279
BEFORE (matches exactly once):

```ts
  return null;
}

/**
 * Safely parses and validates
```

AFTER:

```ts
  return null;
}

/**
 * Livetest 2026-10-24 bug 1: per-sport total ranges (same numbers as DuelOdds src/utils/meritVerdict.ts SPORT_TOTAL_SANITY_RANGES).
 */
export const JUDGE_TOTAL_RANGES: Record<string, { min: number; max: number }> = {
  americanfootball_nfl: { min: 30, max: 65 },
  americanfootball_ncaaf: { min: 30, max: 80 },
  basketball_nba: { min: 190, max: 260 },
  basketball_ncaab: { min: 110, max: 180 },
  basketball_wnba: { min: 130, max: 190 },
  baseball_mlb: { min: 5, max: 14 },
  baseball_ncaa: { min: 5, max: 18 },
  icehockey_nhl: { min: 4, max: 8 },
};

/** Max |fair - market| before a judgment is rejected (same caps as DuelOdds MODEL_DISAGREEMENT_CAPS). */
export const JUDGE_MARKET_CAPS = { spread: 10, total: 12 };

/** Posted market lines for the cross-check. spread is HOME perspective (negative = home favored), like fairSpread. */
export type JudgeMarketLines = { spread?: number | null; total?: number | null } | null | undefined;

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cross-checks a judgment's fields against each other, the sport and the market.
 * Returns the reason it must be rejected, or null when it is coherent.
 * - sign(fairSpread) (home perspective) must agree with winProbHome (> 0.5 = home favored) and with an explicitly named winner;
 * - |fairSpread - market spread| <= 10;
 * - fairTotal (when given) inside the sport's range and |fairTotal - market total| <= 12.
 */
export function crossCheckJudgeOutput(
  judgment: { winProbHome: number; fairSpread: number; fairTotal: number | null; namedWinner: 'home' | 'away' | null },
  sportKey?: string,
  market?: JudgeMarketLines
): string | null {
  const { winProbHome, fairSpread, fairTotal, namedWinner } = judgment;
  if (winProbHome > 0.5 && fairSpread > 0) {
    return `fairSpread ${fairSpread} favors the away team but winProbHome is ${winProbHome}`;
  }
  if (winProbHome < 0.5 && fairSpread < 0) {
    return `fairSpread ${fairSpread} favors the home team but winProbHome is ${winProbHome}`;
  }
  if (namedWinner === 'home' && winProbHome < 0.5) {
    return `likelyWinner is the home team but winProbHome is ${winProbHome}`;
  }
  if (namedWinner === 'away' && winProbHome > 0.5) {
    return `likelyWinner is the away team but winProbHome is ${winProbHome}`;
  }
  const marketSpread = finiteOrNull(market?.spread);
  if (marketSpread !== null && Math.abs(fairSpread - marketSpread) > JUDGE_MARKET_CAPS.spread) {
    return `fairSpread ${fairSpread} is ${Math.abs(fairSpread - marketSpread)} from the market ${marketSpread} (cap ${JUDGE_MARKET_CAPS.spread})`;
  }
  if (fairTotal !== null) {
    const range = sportKey ? JUDGE_TOTAL_RANGES[sportKey.toLowerCase().trim()] : undefined;
    if (range && (fairTotal < range.min || fairTotal > range.max)) {
      return `fairTotal ${fairTotal} is outside the ${sportKey} range ${range.min}-${range.max}`;
    }
    const marketTotal = finiteOrNull(market?.total);
    if (marketTotal !== null && Math.abs(fairTotal - marketTotal) > JUDGE_MARKET_CAPS.total) {
      return `fairTotal ${fairTotal} is ${Math.abs(fairTotal - marketTotal)} from the market ${marketTotal} (cap ${JUDGE_MARKET_CAPS.total})`;
    }
  }
  return null;
}

/**
 * Safely parses and validates
```

Acceptance: `npm run lint` passes. `npx vitest run src/swarm/server/morning.test.ts` is green (nothing calls the helper yet).
Commit: `git add src/swarm/morning/judgePrompt.ts && git commit -m "step 2"`.

## STEP 3: parseAndValidateJudgeOutput rejects incoherent judgments (S1) and checks the total against the sport range instead of "> 0" (S2), in src/swarm/morning/judgePrompt.ts

(A rejected judgment logs `[MorningJudge] Rejected judgment for AWAY @ HOME: <reason>` and returns null, exactly like a malformed one. A missing or non-numeric total stays null (the prompt allows null); a numeric total <= 0 is rejected.)
3a. parse signature: new optional `market` parameter, at src/swarm/morning/judgePrompt.ts:354-356
BEFORE (matches exactly once):

```ts
  sportKey?: string,
  swarmWorkflowId?: string | null
): MorningJudgeOutput | null {
```

AFTER:

```ts
  sportKey?: string,
  swarmWorkflowId?: string | null,
  market?: JudgeMarketLines
): MorningJudgeOutput | null {
```

3b. likelyWinner: remember which team was named, at src/swarm/morning/judgePrompt.ts:396-401
BEFORE (matches exactly once):

```ts
  let likelyWinner = String(parsed.likelyWinner || parsed.winner || parsed.likely_winner || '').trim();
  if (areTeamsEqual(likelyWinner, normHome)) {
    likelyWinner = normHome;
  } else if (areTeamsEqual(likelyWinner, normAway)) {
    likelyWinner = normAway;
  } else {
```

AFTER:

```ts
  let likelyWinner = String(parsed.likelyWinner || parsed.winner || parsed.likely_winner || '').trim();
  let namedWinner: 'home' | 'away' | null = null;
  if (areTeamsEqual(likelyWinner, normHome)) {
    likelyWinner = normHome;
    namedWinner = 'home';
  } else if (areTeamsEqual(likelyWinner, normAway)) {
    likelyWinner = normAway;
    namedWinner = 'away';
  } else {
```

3c. fair total: "> 0" becomes the sport range (S2) + cross-check before anything is returned (S1), at src/swarm/morning/judgePrompt.ts:412-418
BEFORE (matches exactly once):

```ts
// Fair total
let fairTotal: number | null = null;
const rawTotal = parsed.fairTotal ?? parsed.fair_total;
if (rawTotal != null && !isNaN(Number(rawTotal)) && Number(rawTotal) > 0) {
  fairTotal = Number(rawTotal);
}
```

AFTER:

```ts
// Fair total: null when absent or not a number (the prompt allows null); a numeric total must be > 0 and
// inside the sport's range (cross-check below), so 135.5 for NCAAF is rejected instead of accepted as "> 0".
let fairTotal: number | null = null;
const rawTotal = parsed.fairTotal ?? parsed.fair_total;
const totalNum = rawTotal == null || rawTotal === "" ? NaN : Number(rawTotal);
if (Number.isFinite(totalNum)) {
  if (totalNum <= 0) {
    console.warn(
      `[MorningJudge] Rejected judgment for ${normAway} @ ${normHome}: fairTotal ${totalNum} is not positive`,
    );
    return null;
  }
  fairTotal = totalNum;
}

// Livetest 2026-10-24 bug 1: cross-check spread / win probability / winner / totals before anything is written
const rejection = crossCheckJudgeOutput(
  { winProbHome, fairSpread: fairSpreadNum, fairTotal, namedWinner },
  sportKey,
  market,
);
if (rejection) {
  console.warn(
    `[MorningJudge] Rejected judgment for ${normAway} @ ${normHome}: ${rejection}`,
  );
  return null;
}
```

Acceptance: `npm run lint` passes. `npx vitest run src/swarm/server/morning.test.ts` is green. (morningCacheBypass.test.ts fails until step 5 fixes its incoherent fixture; that is expected here.)
Commit: `git add src/swarm/morning/judgePrompt.ts && git commit -m "step 3"`.

## STEP 4: prompts: NCAAF/NCAAB ranges (S3), sport-neutral fairTotal example (S4), in src/swarm/morning/judgePrompt.ts

(The 215.5 example (an NBA total) appears twice: buildJudgePrompt and JUDGE_MANAGER_INSTRUCTION. Both become null and the ranges in rule 3 carry the guidance. Keep the examples VALID JSON and keep JUDGE_MANAGER_INSTRUCTION short: a longer manager prompt pushes the two-game morningCacheBypass test over the Groq 7000 tokens/min limiter window (it then waits ~60s and times out), and an angle-bracket placeholder did the same in the dry run. Same reason the manager rule 3 points to the per-game rule 3 instead of repeating the ranges.)
4a. buildJudgePrompt example (first of the two identical blocks; the BEFORE includes the line above it to make it unique), at src/swarm/morning/judgePrompt.ts:68-73
BEFORE (matches exactly once):

```ts
  "likelyWinner": "${game.homeTeam} or ${game.awayTeam}",
  "winProbHome": 0.55,
  "winProbAway": 0.45,
  "fairSpread": -3.5,
  "fairTotal": 215.5,
  "totalLean": "over",
```

AFTER:

```ts
  "likelyWinner": "${game.homeTeam} or ${game.awayTeam}",
  "winProbHome": 0.55,
  "winProbAway": 0.45,
  "fairSpread": -3.5,
  "fairTotal": null,
  "totalLean": "over",
```

4b. buildJudgePrompt rule 3: add NCAAF and NCAAB (S3), at src/swarm/morning/judgePrompt.ts:93
BEFORE (matches exactly once):

```ts
3. "fairTotal": Must be a realistic game total appropriate to this sport (e.g. NFL: 30-65, NBA: 190-260, MLB: 5-14, NHL: 4-8) or null if unable to estimate.
```

AFTER:

```ts
3. "fairTotal": Must be a realistic game total appropriate to this sport (e.g. NFL: 30-65, NCAAF: 30-80, NBA: 190-260, NCAAB: 110-180, MLB: 5-14, NHL: 4-8) or null if unable to estimate.
```

4c. JUDGE_MANAGER_INSTRUCTION example (the only 215.5 left after 4a), at src/swarm/morning/judgePrompt.ts:106-109
BEFORE (matches exactly once):

```ts
  "winProbAway": 0.45,
  "fairSpread": -3.5,
  "fairTotal": 215.5,
  "totalLean": "over",
```

AFTER:

```ts
  "winProbAway": 0.45,
  "fairSpread": -3.5,
  "fairTotal": null,
  "totalLean": "over",
```

4d. JUDGE_MANAGER_INSTRUCTION rule 3, at src/swarm/morning/judgePrompt.ts:127
BEFORE (matches exactly once):

```ts
3. "fairTotal": Realistic game total or null.
```

AFTER:

```ts
3. "fairTotal": Realistic total inside the sport range in prompt rule 3, or null.
```

Acceptance: `npm run lint` passes. `git grep -n "215.5" -- src/swarm/morning/judgePrompt.ts` prints nothing. `git grep -n "NCAAF: 30-80" -- src/swarm/morning/judgePrompt.ts` prints one line. morning.test.ts green.
Commit: `git add src/swarm/morning/judgePrompt.ts && git commit -m "step 4"`.

GROUP CHECK (JP done): `npm run lint && npx vitest run src/swarm/server/morning.test.ts`. If it's green, continue straight to the next group without stopping.

==========================================================================================
STEP 5: runMorningSlate passes the market lines; clearer error; two tests updated, in src/swarm/morning/index.ts + 2 test files

---

(Downstream of a rejection (checked on 31f9aaa): parse returns null → errors.push + continue, BEFORE computeModelSnapshot and upsertGameJudgment, so nothing is written and no game is half-written; the per-game try/catch stays; the run continues to the next game and returns ok=false. No retry and no fallback judge (by design, "Do not add a direct-judge fallback"). The game stays claimed for MORNING_CLAIM_TTL_MS (20 min) and the next run judges it again. morningCacheBypass game 2 had spread -2.5 (home favored) with winProbHome 0.41 (away favored): exactly the incoherence S1 rejects, so the fixture becomes +2.5.)
5a. pass the market lines, at src/swarm/morning/index.ts:247-249
BEFORE (matches exactly once):

```ts
        game.sport,
        workflowResult?.workflowId
      );
```

AFTER:

```ts
        game.sport,
        workflowResult?.workflowId,
        // ESPN's spread is home perspective like fairSpread; used for the |fair - market| caps (livetest bug 1)
        { spread: game.oddsSnapshot?.spread ?? null, total: game.oddsSnapshot?.overUnder ?? null }
      );
```

5b. error text + what happens next, at src/swarm/morning/index.ts:253-257
BEFORE (matches exactly once):

```ts
      if (!parsed) {
        errors.push({
          eventId: game.eventId,
          error: "judge output missing winProbHome or fairSpread"
        });
```

AFTER:

```ts
      if (!parsed) {
        // Nothing is written for this game (the upsert below is skipped). No retry or fallback judge in this run:
        // the game stays claimed for MORNING_CLAIM_TTL_MS and the next run judges it again.
        errors.push({
          eventId: game.eventId,
          error: "judge output missing, malformed or inconsistent (see [MorningJudge] warning)"
        });
```

5c. expected error text, at src/swarm/server/morning.test.ts:839
BEFORE (matches exactly once):

```ts
        { eventId: 'nfl-game-unjudged-1', error: 'judge output missing winProbHome or fairSpread' }
```

AFTER:

```ts
        { eventId: 'nfl-game-unjudged-1', error: 'judge output missing, malformed or inconsistent (see [MorningJudge] warning)' }
```

5d. game 2 fixture: spread sign matches winProbHome 0.41, at src/swarm/server/morningCacheBypass.test.ts:30
BEFORE (matches exactly once):

```ts
    spread: -2.5,
```

AFTER:

```ts
    spread: 2.5, // away favored: matches winProbHome 0.41 (the judge cross-check rejects a mismatched sign)
```

Acceptance: `npm run lint` passes. `npx vitest run src/swarm/server/morning.test.ts src/swarm/server/morningCacheBypass.test.ts` green (28 + 2), each in a few seconds (no 5s timeout).
Commit: `git add src/swarm/morning/index.ts src/swarm/server/morning.test.ts src/swarm/server/morningCacheBypass.test.ts && git commit -m "step 5"`.

## STEP 6: NEW FILE src/swarm/server/judgeCrossCheck.test.ts (S1-S4 + a rejected judgment never crashes the run or writes a half game)

NEW FILE src/swarm/server/judgeCrossCheck.test.ts (108 lines), exact content:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  crossCheckJudgeOutput,
  parseAndValidateJudgeOutput,
  buildJudgePrompt,
  JUDGE_MANAGER_INSTRUCTION,
} from "../morning/judgePrompt.ts";
import {
  runMorningSlate,
  createMorningClaimStore,
  resetMorningSingleFlight,
} from "../morning/index.ts";

/** DuelOdds live test 2026-10-24 bug 1: the judge's spread, win probability, winner and total disagreed with each other. */
const judge = (o: Record<string, unknown>) =>
  JSON.stringify({ totalLean: "none", arguments: [], ...o });

describe("judge cross-check (S1-S4)", () => {
  it("rejects an away winner with winProbHome 0.88 and spread -16.5 (LSU @ Auburn)", () => {
    const raw = judge({
      likelyWinner: "LSU",
      winProbHome: 0.88,
      winProbAway: 0.12,
      fairSpread: -16.5,
      fairTotal: 52,
    });
    expect(
      parseAndValidateJudgeOutput(
        raw,
        "Auburn",
        "LSU",
        "americanfootball_ncaaf",
      ),
    ).toBeNull();
  });

  it("rejects winProbHome 0.57 with a positive (away-favored) spread (Miami OH @ CMU)", () => {
    expect(
      crossCheckJudgeOutput(
        {
          winProbHome: 0.57,
          fairSpread: 3.5,
          fairTotal: 45,
          namedWinner: "home",
        },
        "americanfootball_ncaaf",
      ),
    ).not.toBeNull();
  });

  it("rejects a spread more than 10 from the market", () => {
    expect(
      crossCheckJudgeOutput(
        {
          winProbHome: 0.9,
          fairSpread: -17,
          fairTotal: 50,
          namedWinner: "home",
        },
        "americanfootball_nfl",
        { spread: -3, total: 47 },
      ),
    ).toMatch(/spread/i);
  });

  it("rejects an NCAAF total of 135.5 (outside 30-80)", () => {
    expect(
      crossCheckJudgeOutput(
        {
          winProbHome: 0.6,
          fairSpread: -3,
          fairTotal: 135.5,
          namedWinner: "home",
        },
        "americanfootball_ncaaf",
      ),
    ).toMatch(/total/i);
  });

  it("rejects a total more than 12 from the market", () => {
    expect(
      crossCheckJudgeOutput(
        {
          winProbHome: 0.6,
          fairSpread: -3,
          fairTotal: 220,
          namedWinner: "home",
        },
        "basketball_nba",
        { spread: -3, total: 235 },
      ),
    ).toMatch(/total/i);
  });

  it("accepts a coherent judgment and a null total", () => {
    expect(
      crossCheckJudgeOutput(
        {
          winProbHome: 0.64,
          fairSpread: -4.5,
          fairTotal: 221.5,
          namedWinner: "home",
        },
        "basketball_nba",
        { spread: -4, total: 220 },
      ),
    ).toBeNull();
    const raw = judge({
      likelyWinner: "Knicks",
      winProbHome: 0.41,
      winProbAway: 0.59,
      fairSpread: 2.5,
      fairTotal: null,
    });
    const out = parseAndValidateJudgeOutput(
      raw,
      "Celtics",
      "Knicks",
      "basketball_nba",
      undefined,
      { spread: 2, total: 219.5 },
    );
    expect(out).not.toBeNull();
    expect(out!.fairTotal).toBeNull();
  });

  it("prompts list the NCAAF range and no longer carry the NBA-only 215.5 example", () => {
    const p = buildJudgePrompt({
      homeTeam: "Auburn",
      awayTeam: "LSU",
      sport: "americanfootball_ncaaf",
    } as any);
    expect(p).toContain("NCAAF: 30-80");
    expect(p).not.toContain("215.5");
    expect(JUDGE_MANAGER_INSTRUCTION).not.toContain("215.5");
  });
});

describe("runMorningSlate with a rejected judgment", () => {
  afterEach(() => {
    resetMorningSingleFlight();
    vi.restoreAllMocks();
  });

  it("writes the coherent game, writes nothing for the rejected one, and returns an error without throwing", async () => {
    const event = (id: string) => ({
      id,
      date: "2026-10-15T18:00:00Z",
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: `Home ${id}` } },
            { homeAway: "away", team: { displayName: `Away ${id}` } },
          ],
          odds: [{ details: "HOME -3.0", spread: -3.0, overUnder: 48.0 }],
        },
      ],
    });
    const writes: string[] = [];
    const fetchFn = vi
      .fn()
      .mockImplementation(async (url: string, init?: any) => {
        const u = String(url);
        if (u.includes("/sports/football/nfl/"))
          return new Response(
            JSON.stringify({ events: [event("g1"), event("g2")] }),
            { status: 200 },
          );
        if (u.includes("apis/site/v2/sports/"))
          return new Response(JSON.stringify({ events: [] }), { status: 200 });
        if (
          u.includes("game_judgments") &&
          init?.method &&
          init.method !== "GET"
        ) {
          writes.push(String(init.body ?? ""));
          return new Response(null, { status: 201 });
        }
        if (
          u.includes("game_judgments?game_date=") ||
          u.includes("line_snapshots?")
        )
          return new Response("[]", { status: 200 });
        return new Response(null, { status: 201 });
      }) as any;
    const executeWorkflowFn = vi.fn(async (p: any) => {
      const bad = String(p.task).includes("Home g2");
      return {
        workflowId: bad ? "wf-bad" : "wf-ok",
        finalAnalysis: bad
          ? judge({
              likelyWinner: "Away g2",
              winProbHome: 0.88,
              winProbAway: 0.12,
              fairSpread: -16.5,
              fairTotal: 48,
            })
          : judge({
              likelyWinner: "Home g1",
              winProbHome: 0.6,
              winProbAway: 0.4,
              fairSpread: -3,
              fairTotal: 48,
            }),
      };
    });
    const result = await runMorningSlate({
      dateInput: "2026-10-15",
      env: {
        GEMINI_API_KEY: "k",
        SUPABASE_URL: "https://mock.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "s",
      },
      fetchFn,
      executeWorkflowFn: executeWorkflowFn as any,
      claims: createMorningClaimStore(),
    });
    expect(executeWorkflowFn).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.eventId)).toEqual(["nfl-g2"]);
    expect(writes.some((b) => b.includes("nfl-g1"))).toBe(true);
    expect(writes.some((b) => b.includes("nfl-g2"))).toBe(false);
  });
});
```

Acceptance: `npx vitest run src/swarm/server/judgeCrossCheck.test.ts` → 8 passed. No network (fetch is injected; the swarm call is executeWorkflowFn).
Commit: `git add src/swarm/server/judgeCrossCheck.test.ts && git commit -m "step 6"`.
GROUP CHECK (DS done): `npm run lint && npx vitest run src/swarm/server/judgeCrossCheck.test.ts src/swarm/server/morning.test.ts src/swarm/server/morningCacheBypass.test.ts`. If it's green, continue to FINAL VERIFICATION.

==========================================================================================
FINAL VERIFICATION (run once after step 6, Node >= 22)
==========================================================================================

1. `npm run lint` → exit 0.
2. `npm run test:unit` → all green (dry run: 116 files, 984 tests).
3. `npm run test:simulation` → exit 0.
4. `npm run build` → exit 0. (Afterwards `git status` shows .swarm-dts-staging/ deletions: leave them uncommitted.)
5. `node scripts/smoke-start.mjs` → `[smoke] GET /api/health -> 200 ...`, `[smoke] PASS`, exit 0.
6. Strip scan 1 (must print `strip scan: N files, 0 non-erasable`, exit 0):
   node --no-warnings --input-type=module -e "import {stripTypeScriptTypes as s} from 'node:module';import fs from 'node:fs';const fl=process.argv.slice(1);let b=0;for(const f of fl){try{s(fs.readFileSync(f,'utf8'),{mode:'strip'})}catch(e){b++;console.log('NON-ERASABLE',f,e.message.split('\n')[0])}}console.log('strip scan:',fl.length,'files,',b,'non-erasable');process.exit(b?1:0)" $(git ls-files 'server.ts' 'src/\*_/_.ts' 'scripts/_.ts' 'test-_.ts')
   (dry run: 363 files.)
7. Strip scan 2, filtered to this PR's files, must print NOTHING:
   npx tsc --noEmit --erasableSyntaxOnly --verbatimModuleSyntax | grep -E "morning/index\.ts|judgePrompt|morning\.test|morningCacheBypass|judgeCrossCheck"
8. Greps: `git grep -n "215.5" -- src/swarm/morning/judgePrompt.ts` → nothing; `git grep -n "crossCheckJudgeOutput(" -- src/swarm/morning/judgePrompt.ts` → 2 lines.
9. `git diff --stat $JC_BASE HEAD` → 5 files: src/swarm/morning/index.ts, src/swarm/morning/judgePrompt.ts,
   src/swarm/server/judgeCrossCheck.test.ts (new), src/swarm/server/morning.test.ts, src/swarm/server/morningCacheBypass.test.ts.
   `git log --oneline $JC_BASE..HEAD` → 6 commits (step 1 to step 6). Then push the branch and open ONE PR.

==========================================================================================
TYLER STEPS (Tyler only. The IDE never runs these.)
==========================================================================================
MIGRATIONS: none. ENV: none. DATA DELETIONS / RE-JUDGE: none in this PR; re-judging old incoherent rows needs Tyler's approval (and a backup first).
T1. Review and merge the PR; Render deploys the swarm service as usual.
T2. After the next 10 PM CT morning run (read-only): search Render logs for "[MorningJudge] Rejected judgment". Each is a game skipped this run
and re-judged by the next run after its 20-min claim. Many rejections for one sport would point at a bad range or a feed spread in away
perspective; tell Navigator.

==========================================================================================
GAPS / SKIPPED
==========================================================================================
G1. No retry or fallback judge on rejection (by design); a game the judge keeps getting wrong stays unjudged until a later run gets it right.
G2. The ESPN spread is assumed home perspective (as fairSpread). If a feed ever sends away perspective, the |fair - market| cap would reject
coherent judgments; T2 would show it.
G3. Prompt length matters: the Groq limiter is 7000 tokens/min. A longer JUDGE_MANAGER_INSTRUCTION made the two-game morningCacheBypass test
wait ~60s for the window (5s timeout), so the manager prompt points at rule 3 instead of repeating the ranges. Same budget in production.
G4. DuelOdds-side items from ide_duelodds_livetest_fixes.txt are not in this file (Swarm repo only).
