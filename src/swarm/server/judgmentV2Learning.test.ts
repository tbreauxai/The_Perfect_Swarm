import { describe, it, expect, vi, afterEach } from "vitest";
import {
  hydrateCalibrationFromSupabase,
  fetchPregameLearningContext,
} from "../morning/supabase.ts";
import { gradeAndRecordFinalGames } from "../morning/feedback.ts";

/** S6 (JUDGMENT_SCHEMA_V2 on): calibration, history and Brier read win_prob_home_code / proj_margin; no math_version = skipped. */
const cfg = {
  supabaseUrl: "https://mock.supabase.co",
  supabaseServiceKey: "s",
};

function mockFetch(rowsFor: (u: string) => any[] | null) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    const u = String(url);
    urls.push(u);
    if (init?.method && init.method !== "GET")
      return new Response(null, { status: 204 });
    const rows = rowsFor(u);
    return new Response(JSON.stringify(rows ?? []), { status: 200 });
  }) as any;
  return { fn, urls };
}

afterEach(() => vi.restoreAllMocks());

describe("S6 calibration hydrate", () => {
  const rows = [
    {
      event_id: "a",
      workflow_id: "wf-a",
      win_prob_home_code: 0.7,
      math_version: "m1",
      sport: "americanfootball_nfl",
      result: { outcome: "win" },
      judged_at: "2026-10-01T00:00:00Z",
    },
    {
      event_id: "b",
      workflow_id: "wf-b",
      win_prob_home_code: 0.6,
      math_version: null,
      sport: "americanfootball_nfl",
      result: { outcome: "loss" },
      judged_at: "2026-10-01T00:00:00Z",
    },
  ];
  it("flag on: selects win_prob_home_code + math_version and skips rows without math_version", async () => {
    const { fn, urls } = mockFetch(() => rows);
    expect(await hydrateCalibrationFromSupabase(cfg, fn, true)).toBe(1);
    expect(urls[0]).toContain("math_version=not.is.null");
    expect(urls[0]).toContain(
      "select=event_id,workflow_id,win_prob_home_code,math_version,sport,result,judged_at",
    );
  });
  it("flag off: the v1 select, unchanged", async () => {
    const { fn, urls } = mockFetch(() => []);
    await hydrateCalibrationFromSupabase(cfg, fn);
    expect(urls[0]).toBe(
      "https://mock.supabase.co/rest/v1/game_judgments?status=eq.final&brier=not.is.null&order=judged_at.desc&limit=200&select=event_id,workflow_id,win_prob_home,sport,result,judged_at",
    );
  });
});

describe("S6 pregame history", () => {
  const game: any = {
    eventId: "nfl-x",
    sport: "americanfootball_nfl",
    homeTeam: "Bears",
    awayTeam: "Lions",
    gameDate: "2026-10-15",
  };
  it("flag on: margin error from proj_margin, note shows ProjMargin, no-math_version rows skipped", async () => {
    const { fn, urls } = mockFetch((u) =>
      u.includes("game_judgments")
        ? [
            {
              home_team: "Bears",
              away_team: "Packers",
              win_prob_home_code: 0.6,
              proj_margin: 3,
              math_version: "m1",
              result: { outcome: "win", margin: 7 },
              brier: 0.16,
            },
            {
              home_team: "Bears",
              away_team: "Vikings",
              win_prob_home_code: 0.6,
              proj_margin: 30,
              math_version: null,
              result: { outcome: "loss", margin: -3 },
              brier: 0.36,
            },
          ]
        : [],
    );
    const ctx = await fetchPregameLearningContext(cfg, game, fn, true);
    const hist = urls.find((u) => u.includes("game_judgments"))!;
    expect(hist).toContain(
      "select=home_team,away_team,win_prob_home_code,proj_margin,math_version,result,brier&math_version=not.is.null",
    );
    expect(ctx.formattedBlock).toContain("ProjMargin=3");
    expect(ctx.formattedBlock).not.toContain("Vikings");
    expect(ctx.formattedBlock).not.toContain("FairSpread");
  });
});

describe("S6 Brier grading", () => {
  const games: any[] = [
    {
      eventId: "nfl-1",
      sport: "americanfootball_nfl",
      homeTeam: "H",
      awayTeam: "A",
      gameDate: "2026-10-15",
      rawEvent: { completed: true, homeScore: 24, awayScore: 17 },
    },
    {
      eventId: "nfl-2",
      sport: "americanfootball_nfl",
      homeTeam: "H2",
      awayTeam: "A2",
      gameDate: "2026-10-15",
      rawEvent: { completed: true, homeScore: 10, awayScore: 17 },
    },
  ];
  it("flag on: grades on win_prob_home_code, skips a row without math_version", async () => {
    const { fn, urls } = mockFetch((u) =>
      u.includes("game_judgments?game_date=")
        ? [
            {
              event_id: "nfl-1",
              workflow_id: "wf-1",
              win_prob_home_code: 0.8,
              math_version: "m1",
              sport: "americanfootball_nfl",
              home_team: "H",
              away_team: "A",
            },
            {
              event_id: "nfl-2",
              workflow_id: "wf-2",
              win_prob_home_code: null,
              math_version: null,
              sport: "americanfootball_nfl",
              home_team: "H2",
              away_team: "A2",
            },
          ]
        : [],
    );
    const settled = await gradeAndRecordFinalGames(
      cfg,
      games,
      "2026-10-15",
      fn,
      { v2: true },
    );
    expect(urls.find((u) => u.includes("status=neq.final"))).toContain(
      "win_prob_home_code,math_version",
    );
    expect(settled.map((s: any) => s.eventId)).toEqual(["nfl-1"]);
  });
});
