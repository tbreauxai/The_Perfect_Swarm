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
