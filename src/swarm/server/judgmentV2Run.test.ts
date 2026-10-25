import { describe, it, expect, afterEach, vi } from "vitest";
import {
  runMorningSlate,
  createMorningClaimStore,
  resetMorningSingleFlight,
} from "../morning/index.ts";

/** JUDGMENT_SCHEMA_V2 end to end with a mocked ESPN + PostgREST (no network). */
export const V2_COLUMNS = [
  "schema_version",
  "proj_margin",
  "proj_total",
  "side",
  "confidence",
  "reasons",
  "validation_flag",
  "math_version",
  "rejudge_count",
  "fair_spread_code",
  "fair_total_code",
  "win_prob_home_code",
  "devig_home",
  "ev_home",
  "ev_away",
  "ev_over",
  "ev_under",
];

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

export const GOOD_V2 = JSON.stringify({
  side: "home",
  projMargin: 4,
  projTotal: 50,
  totalLean: "over",
  confidence: 0.6,
  reasons: ["Home pass rush"],
});
export const BAD_V2 = JSON.stringify({
  side: "away",
  projMargin: 4,
  projTotal: 50,
  totalLean: "over",
  confidence: 0.6,
  reasons: ["sign flipped"],
});
export const GOOD_V1 = JSON.stringify({
  likelyWinner: "Home g1",
  winProbHome: 0.6,
  winProbAway: 0.4,
  fairSpread: -3,
  fairTotal: 48,
  totalLean: "none",
  arguments: [],
});

export async function runSlate(opts: {
  flag?: string;
  rows?: any[];
  reply: string;
}) {
  const gets: string[] = [];
  const writes: { url: string; body: any }[] = [];
  const fetchFn = vi
    .fn()
    .mockImplementation(async (url: string, init?: any) => {
      const u = String(url);
      if (u.includes("/sports/football/nfl/"))
        return new Response(JSON.stringify({ events: [event("g1")] }), {
          status: 200,
        });
      if (u.includes("apis/site/v2/sports/"))
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      if (u.includes("supabase.co")) {
        if (init?.method && init.method !== "GET") {
          let body: any = init.body;
          try {
            body = JSON.parse(String(init.body));
          } catch {
            /* raw */
          }
          writes.push({ url: u, body });
          return new Response(null, { status: 201 });
        }
        gets.push(u);
        if (
          u.includes("game_judgments?game_date=") &&
          u.includes("judge_source")
        )
          return new Response(JSON.stringify(opts.rows ?? []), { status: 200 });
        return new Response("[]", { status: 200 });
      }
      return new Response(null, { status: 201 });
    }) as any;
  const executeWorkflowFn = vi.fn(async (_p: any) => ({
    workflowId: "wf-1",
    finalAnalysis: opts.reply,
  }));
  const env: Record<string, string> = {
    GEMINI_API_KEY: "k",
    SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "s",
  };
  if (opts.flag != null) env.JUDGMENT_SCHEMA_V2 = opts.flag;
  const result = await runMorningSlate({
    dateInput: "2026-10-15",
    env,
    fetchFn,
    executeWorkflowFn: executeWorkflowFn as any,
    claims: createMorningClaimStore(),
  });
  const judgmentWrites = writes
    .filter((w) => w.url.includes("game_judgments"))
    .map((w) => w.body);
  return { result, gets, writes, judgmentWrites, executeWorkflowFn };
}

afterEach(() => {
  resetMorningSingleFlight();
  vi.restoreAllMocks();
});

describe("JUDGMENT_SCHEMA_V2 on: write path", () => {
  it("uses the v2 prompts and writes the v2 columns, no win_prob_* / fair_*", async () => {
    const { result, judgmentWrites, executeWorkflowFn } = await runSlate({
      flag: "1",
      reply: GOOD_V2,
    });
    expect(result.errors).toEqual([]);
    const p = executeWorkflowFn.mock.calls[0][0];
    expect(p.settings.managerInstruction).toContain('"projMargin"');
    expect(p.task).not.toContain("win probability");
    expect(judgmentWrites).toHaveLength(1);
    const row = judgmentWrites[0];
    expect(row).toMatchObject({
      event_id: "nfl-g1",
      schema_version: 2,
      proj_margin: 4,
      proj_total: 50,
      side: "home",
      confidence: 0.6,
      reasons: ["Home pass rush"],
      validation_flag: null,
      judge_source: "swarm",
      likely_winner: "Home g1",
      total_lean: "over",
    });
    for (const k of [
      "win_prob_home",
      "win_prob_away",
      "fair_spread",
      "fair_total",
      "rejudge_count",
    ]) {
      expect(row).not.toHaveProperty(k);
    }
    expect(row.model_snapshot).toMatchObject({
      projected_margin: 4,
      projected_total: 50,
      derived_from: "swarm_judgment_v2",
    });
  });

  it("reads the v2 bookkeeping columns in the partition select", async () => {
    const { gets } = await runSlate({ flag: "1", reply: GOOD_V2 });
    const sel = gets.find(
      (u) =>
        u.includes("game_judgments?game_date=") && u.includes("judge_source"),
    )!;
    expect(sel).toContain(",schema_version,side,rejudge_count,validation_flag");
  });
});

describe("JUDGMENT_SCHEMA_V2 on: rejections (no in-run retry)", () => {
  it("failure 1: one call, rejudge_count 1, no side, game re-judged next run", async () => {
    const { result, judgmentWrites, executeWorkflowFn } = await runSlate({
      flag: "1",
      reply: BAD_V2,
    });
    expect(executeWorkflowFn).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.errors[0].error).toContain("side_mismatch");
    expect(judgmentWrites).toHaveLength(1);
    expect(judgmentWrites[0]).toMatchObject({
      event_id: "nfl-g1",
      schema_version: 2,
      rejudge_count: 1,
    });
    expect(judgmentWrites[0]).not.toHaveProperty("side");
    expect(judgmentWrites[0]).not.toHaveProperty("judge_source");
    expect(judgmentWrites[0]).not.toHaveProperty("validation_flag");
  });

  it("a pending row (schema_version 2, no side) is re-judged on the next run", async () => {
    const rows = [
      {
        event_id: "nfl-g1",
        judge_source: null,
        status: "judged",
        schema_version: 2,
        side: null,
        rejudge_count: 1,
        validation_flag: null,
      },
    ];
    const { result, executeWorkflowFn, judgmentWrites } = await runSlate({
      flag: "1",
      rows,
      reply: GOOD_V2,
    });
    expect(executeWorkflowFn).toHaveBeenCalledTimes(1);
    expect(result.replaced).toBe(1);
    expect(judgmentWrites[0]).toMatchObject({
      side: "home",
      validation_flag: null,
    });
  });

  it("failure 2: stored as pass + validation_flag 'validation_failed'", async () => {
    const rows = [
      {
        event_id: "nfl-g1",
        judge_source: null,
        status: "judged",
        schema_version: 2,
        side: null,
        rejudge_count: 1,
        validation_flag: null,
      },
    ];
    const { judgmentWrites } = await runSlate({
      flag: "1",
      rows,
      reply: BAD_V2,
    });
    expect(judgmentWrites).toHaveLength(1);
    expect(judgmentWrites[0]).toMatchObject({
      rejudge_count: 2,
      side: "pass",
      validation_flag: "validation_failed",
      judge_source: "swarm",
    });
  });

  it("a validation_failed row is never re-judged", async () => {
    const rows = [
      {
        event_id: "nfl-g1",
        judge_source: "swarm",
        status: "judged",
        schema_version: 2,
        side: "pass",
        rejudge_count: 2,
        validation_flag: "validation_failed",
      },
    ];
    const { result, executeWorkflowFn } = await runSlate({
      flag: "1",
      rows,
      reply: GOOD_V2,
    });
    expect(executeWorkflowFn).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

/** S8: every PostgREST column a URL names (select lists, filters, order) and every key a body writes. */
function columnsUsed(gets: string[], writes: { url: string; body: any }[]): Set<string> {
  const cols = new Set<string>();
  for (const u of [...gets, ...writes.map((w) => w.url)]) {
    const q = decodeURIComponent(u.split("?")[1] ?? "");
    for (const part of q.split("&")) {
      const [k, v = ""] = part.split("=");
      if (k === "select" || k === "order") v.split(",").forEach((c) => cols.add(c.split(".")[0]));
      else if (k) cols.add(k);
    }
  }
  for (const w of writes) {
    const rows = Array.isArray(w.body) ? w.body : [w.body];
    for (const r of rows) if (r && typeof r === "object") Object.keys(r).forEach((k) => cols.add(k));
  }
  return cols;
}

describe("JUDGMENT_SCHEMA_V2 off (default): v1 exactly as before", () => {
  for (const flag of [undefined, "", "0", "false"]) {
    it(`flag ${JSON.stringify(flag)}: no v2 column in any select, filter or insert`, async () => {
      const { gets, writes } = await runSlate({ flag, reply: GOOD_V1 });
      expect(gets.length).toBeGreaterThan(0);
      const used = columnsUsed(gets, writes);
      for (const c of V2_COLUMNS) expect(used.has(c), c).toBe(false);
    });
  }

  it("writes the v1 row (win_prob_* / fair_*) with the v1 prompts", async () => {
    const { result, judgmentWrites, executeWorkflowFn } = await runSlate({ reply: GOOD_V1 });
    expect(result.errors).toEqual([]);
    const p = executeWorkflowFn.mock.calls[0][0];
    expect(p.settings.managerInstruction).toContain('"winProbHome"');
    expect(p.task).toContain("win probability");
    expect(judgmentWrites).toHaveLength(1);
    expect(judgmentWrites[0]).toMatchObject({
      event_id: "nfl-g1", win_prob_home: 0.6, win_prob_away: 0.4, fair_spread: -3, fair_total: 48, judge_source: "swarm",
    });
  });

  it("a v2-shaped reply is rejected by the v1 parser and nothing is written (no rejudge_count)", async () => {
    const { result, judgmentWrites } = await runSlate({ reply: GOOD_V2 });
    expect(result.ok).toBe(false);
    expect(judgmentWrites).toHaveLength(0);
  });
});

describe("JUDGMENT_SCHEMA_V2 on: the v2 columns do appear", () => {
  it("partition select and write use v2 names", async () => {
    const { gets, writes } = await runSlate({ flag: "1", reply: GOOD_V2 });
    const used = columnsUsed(gets, writes);
    for (const c of ["schema_version", "proj_margin", "proj_total", "side", "confidence", "reasons", "validation_flag", "rejudge_count"]) {
      expect(used.has(c), c).toBe(true);
    }
  });
});
