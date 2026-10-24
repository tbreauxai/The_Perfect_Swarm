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
