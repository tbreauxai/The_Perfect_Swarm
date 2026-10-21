import { describe, it, expect, afterEach, vi } from "vitest";
import {
  insertBaselineLineSnapshots,
  gradeAndRecordFinalGames,
  type SlateGame,
  type SupabaseConfig,
} from "../morning/index.ts";

const cfg: SupabaseConfig = {
  supabaseUrl: "https://mock.supabase.co",
  supabaseServiceKey: "mock-key",
};

const nbaGame = (odds: {
  spread: number | null;
  overUnder: number | null;
  homeMoneyLine?: number | null;
  awayMoneyLine?: number | null;
}): SlateGame => ({
  eventId: "nba-401908945",
  sport: "basketball_nba",
  league: "nba",
  homeTeam: "Lakers",
  awayTeam: "Celtics",
  commenceTime: "2026-10-16T23:30:00Z",
  gameDate: "2026-10-16",
  weatherSnapshot: null,
  oddsSnapshot: { provider: "DraftKings", ...odds } as any,
});

/**
 * In-memory line_snapshots table that enforces the live partial unique index
 * line_snapshots_one_baseline (game_date, event_id) WHERE is_baseline: a second baseline gets 409/23505.
 */
function snapshotTable(seed: any[] = []) {
  const rows: any[] = [...seed];
  const conflicts: any[] = [];
  const fetchFn = vi
    .fn()
    .mockImplementation(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const q = u.searchParams;
      if (u.pathname.endsWith("/line_snapshots") && init?.method === "GET") {
        const eq = (k: string) => q.get(k)?.replace(/^eq\./, "");
        let hits = rows.filter((r) => r.event_id === eq("event_id"));
        if (q.has("game_date"))
          hits = hits.filter((r) => r.game_date === eq("game_date"));
        if (q.has("is_baseline"))
          hits = hits.filter(
            (r) => String(r.is_baseline) === eq("is_baseline"),
          );
        hits = [...hits].sort((a, b) =>
          String(b.snapshot_at).localeCompare(String(a.snapshot_at)),
        );
        return new Response(
          JSON.stringify(hits.slice(0, Number(q.get("limit") ?? hits.length))),
          { status: 200 },
        );
      }
      if (u.pathname.endsWith("/line_snapshots") && init?.method === "POST") {
        const row = JSON.parse(String(init.body));
        if (
          row.is_baseline &&
          rows.some(
            (r) =>
              r.is_baseline &&
              r.game_date === row.game_date &&
              r.event_id === row.event_id,
          )
        ) {
          conflicts.push(row);
          return new Response(
            JSON.stringify({
              code: "23505",
              message:
                'duplicate key value violates unique constraint "line_snapshots_one_baseline"',
            }),
            { status: 409 },
          );
        }
        rows.push({ ...row, snapshot_at: row.snapshot_at + `#${rows.length}` });
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
  return {
    rows,
    conflicts,
    fetchFn: fetchFn as unknown as typeof fetch,
    mock: fetchFn,
  };
}

describe("Morning write-error hotfix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("line_snapshots baseline (409/23505 line_snapshots_one_baseline)", () => {
    it("the first snapshot of the day is the baseline", async () => {
      const t = snapshotTable();
      const count = await insertBaselineLineSnapshots(
        cfg,
        [nbaGame({ spread: -4.5, overUnder: 221.5 })],
        t.fetchFn,
      );
      expect(count).toBe(1);
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0].is_baseline).toBe(true);
    });

    it("a moved line is inserted with is_baseline false: no 409, and still exactly one baseline per game", async () => {
      const t = snapshotTable();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        await insertBaselineLineSnapshots(
          cfg,
          [nbaGame({ spread: -4.5, overUnder: 221.5 })],
          t.fetchFn,
        ),
      ).toBe(1);
      expect(
        await insertBaselineLineSnapshots(
          cfg,
          [nbaGame({ spread: -5.5, overUnder: 222.5 })],
          t.fetchFn,
        ),
      ).toBe(1);
      expect(
        await insertBaselineLineSnapshots(
          cfg,
          [nbaGame({ spread: -6, overUnder: 222.5 })],
          t.fetchFn,
        ),
      ).toBe(1);

      expect(t.conflicts).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(t.rows.map((r) => r.is_baseline)).toEqual([true, false, false]);
      expect(t.rows.filter((r) => r.is_baseline)).toHaveLength(1);
    });

    it("looks the baseline up by game_date + event_id + is_baseline (the unique index key)", async () => {
      const t = snapshotTable();
      await insertBaselineLineSnapshots(
        cfg,
        [nbaGame({ spread: -4.5, overUnder: 221.5 })],
        t.fetchFn,
      );
      const urls = t.mock.mock.calls.map((c: any[]) => String(c[0]));
      expect(
        urls.some((u: string) =>
          u.includes(
            "line_snapshots?game_date=eq.2026-10-16&event_id=eq.nba-401908945&is_baseline=eq.true&select=id&limit=1",
          ),
        ),
      ).toBe(true);
    });

    it("a baseline from an earlier run today (seeded) makes a moved line non-baseline", async () => {
      const t = snapshotTable([
        {
          event_id: "nba-401908945",
          game_date: "2026-10-16",
          spread: -4.5,
          total: 221.5,
          ml_home: null,
          ml_away: null,
          snapshot_at: "2026-10-16T11:00:00.000Z",
          is_baseline: true,
        },
      ]);
      expect(
        await insertBaselineLineSnapshots(
          cfg,
          [nbaGame({ spread: -5.5, overUnder: 221.5 })],
          t.fetchFn,
        ),
      ).toBe(1);
      expect(t.conflicts).toEqual([]);
      expect(t.rows[1].is_baseline).toBe(false);
    });

    it("null-safe numeric compare: numeric-as-text and null == null count as the same line (skipped, no extra request)", async () => {
      const t = snapshotTable([
        {
          event_id: "nba-401908945",
          game_date: "2026-10-16",
          spread: "-4.5",
          total: "221.5",
          ml_home: null,
          ml_away: null,
          snapshot_at: "2026-10-16T11:00:00.000Z",
          is_baseline: true,
        },
      ]);
      const count = await insertBaselineLineSnapshots(
        cfg,
        [nbaGame({ spread: -4.5, overUnder: 221.5, homeMoneyLine: null })],
        t.fetchFn,
      );
      expect(count).toBe(0);
      expect(t.rows).toHaveLength(1);
      // Only the latest-line read ran; no baseline lookup and no POST.
      expect(t.mock).toHaveBeenCalledTimes(1);
    });

    it("null vs a number is a moved line (not treated as equal)", async () => {
      const t = snapshotTable([
        {
          event_id: "nba-401908945",
          game_date: "2026-10-16",
          spread: -4.5,
          total: null,
          ml_home: null,
          ml_away: null,
          snapshot_at: "2026-10-16T11:00:00.000Z",
          is_baseline: true,
        },
      ]);
      expect(
        await insertBaselineLineSnapshots(
          cfg,
          [nbaGame({ spread: -4.5, overUnder: 0 })],
          t.fetchFn,
        ),
      ).toBe(1);
      expect(t.rows[1].is_baseline).toBe(false);
    });
  });

  describe("game_judgments settle PATCH (PGRST204 final_result)", () => {
    const finalGame = (
      eventId: string,
      homeScore: number,
      awayScore: number,
    ): SlateGame => ({
      eventId,
      sport: "icehockey_nhl",
      league: "nhl",
      homeTeam: "Avalanche",
      awayTeam: "Stars",
      commenceTime: "2026-10-15T01:00:00Z",
      gameDate: "2026-10-15",
      weatherSnapshot: null,
      oddsSnapshot: null,
      rawEvent: { completed: true, homeScore, awayScore },
    });

    /** Supabase mock that rejects unknown game_judgments columns the way PostgREST does (PGRST204). */
    function judgmentsFetch(judgments: any[]) {
      const patches: any[] = [];
      const fetchFn = vi
        .fn()
        .mockImplementation(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes("game_judgments?game_date=") &&
            init?.method === "GET"
          ) {
            return new Response(JSON.stringify(judgments), { status: 200 });
          }
          if (
            String(url).includes("game_judgments?") &&
            init?.method === "PATCH"
          ) {
            const body = JSON.parse(String(init.body));
            const allowed = new Set(["status", "result", "brier"]);
            const bad = Object.keys(body).find((k) => !allowed.has(k));
            if (bad) {
              return new Response(
                JSON.stringify({
                  code: "PGRST204",
                  message: `Could not find the '${bad}' column of 'game_judgments'`,
                }),
                { status: 400 },
              );
            }
            patches.push({ url: String(url), body });
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 200 });
        });
      return { patches, fetchFn: fetchFn as unknown as typeof fetch };
    }

    const judgment = (eventId: string, winProbHome: any) => ({
      event_id: eventId,
      workflow_id: `wf-hotfix-${eventId}`,
      win_prob_home: winProbHome,
      sport: "icehockey_nhl",
      home_team: "Avalanche",
      away_team: "Stars",
    });

    it("writes status final + result {home_score, away_score, home_win, margin, total, outcome, settled_at} + brier, never final_result", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const m = judgmentsFetch([judgment("nhl-401892506", 0.7)]);
      const settled = await gradeAndRecordFinalGames(
        cfg,
        [finalGame("nhl-401892506", 4, 2)],
        "2026-10-15",
        m.fetchFn,
      );

      expect(settled).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      expect(m.patches).toHaveLength(1);
      const { url, body } = m.patches[0];
      expect(url).toContain(
        "game_judgments?game_date=eq.2026-10-15&event_id=eq.nhl-401892506",
      );
      expect(body).not.toHaveProperty("final_result");
      expect(body.status).toBe("final");
      expect(body.result).toMatchObject({
        home_score: 4,
        away_score: 2,
        home_win: true,
        margin: 2,
        total: 6,
        outcome: "win",
      });
      expect(Object.keys(body.result).sort()).toEqual([
        "away_score",
        "home_score",
        "home_win",
        "margin",
        "outcome",
        "settled_at",
        "total",
      ]);
      expect(Number.isNaN(Date.parse(body.result.settled_at))).toBe(false);
      expect(body.brier).toBeCloseTo(0.09, 3);
    });

    it("a home loss: home_win false, negative margin, brier on (p - 0)^2", async () => {
      const m = judgmentsFetch([judgment("nhl-401892507", 0.6)]);
      await gradeAndRecordFinalGames(
        cfg,
        [finalGame("nhl-401892507", 1, 3)],
        "2026-10-15",
        m.fetchFn,
      );
      expect(m.patches[0].body.result).toMatchObject({
        home_win: false,
        margin: -2,
        total: 4,
        outcome: "loss",
      });
      expect(m.patches[0].body.brier).toBeCloseTo(0.36, 3);
    });

    it("a push/tie: calculates brier against 0.5 neutrality instead of 0", async () => {
      const m = judgmentsFetch([judgment("nhl-401892510", 0.6)]);
      await gradeAndRecordFinalGames(
        cfg,
        [finalGame("nhl-401892510", 3, 3)],
        "2026-10-15",
        m.fetchFn,
      );
      expect(m.patches[0].body.result).toMatchObject({
        home_win: false,
        margin: 0,
        total: 6,
        outcome: "push",
      });
      expect(m.patches[0].body.brier).toBeCloseTo(0.01, 3);
    });

    it("brier is rounded to 3 decimals, like the DuelOdds Worker grader", async () => {
      const m = judgmentsFetch([judgment("nhl-401892508", 0.6543)]);
      await gradeAndRecordFinalGames(
        cfg,
        [finalGame("nhl-401892508", 5, 1)],
        "2026-10-15",
        m.fetchFn,
      );
      const expected = Math.round(Math.pow(0.6543 - 1, 2) * 1000) / 1000;
      expect(m.patches[0].body.brier).toBe(expected);
    });

    it("a non-numeric win_prob_home gives brier null (not NaN), and the row is still marked final with a result", async () => {
      const m = judgmentsFetch([judgment("nhl-401892509", "n/a")]);
      await gradeAndRecordFinalGames(
        cfg,
        [finalGame("nhl-401892509", 2, 2)],
        "2026-10-15",
        m.fetchFn,
      );
      expect(m.patches).toHaveLength(1);
      expect(m.patches[0].body.brier).toBeNull();
      expect(m.patches[0].body.result).toMatchObject({
        home_win: false,
        margin: 0,
        total: 4,
        outcome: "push",
      });
    });
  });
});
