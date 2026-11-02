import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { runMorningSlate, createMorningClaimStore, resetMorningSingleFlight } from "../morning/index.ts";

/** JUDGMENT_FACTORS end to end with mocked ESPN + PostgREST (no network, pinned clock). */
const event = {
  id: "g1",
  date: "2026-10-15T18:00:00Z",
  competitions: [
    {
      competitors: [
        { homeAway: "home", team: { displayName: "Home g1" } },
        { homeAway: "away", team: { displayName: "Away g1" } },
      ],
      odds: [{ details: "HOME -3.0", spread: -3.0, overUnder: 48.0 }],
    },
  ],
};
const V2 = { side: "home", projMargin: 4, projTotal: 50, totalLean: "over", confidence: 0.6, reasons: ["Home pass rush"] };
const WITH_FACTORS = JSON.stringify({
  ...V2,
  factors: [{ id: "wind_high", evidence: { kind: "espn_field", ref: "weather.windSpeed" } }],
});

async function run(env: Record<string, string>, reply: string) {
  const writes: any[] = [];
  const fetchFn = vi.fn(async (url: string, init?: any) => {
    const u = String(url);
    if (u.includes("/sports/football/nfl/")) return new Response(JSON.stringify({ events: [event] }), { status: 200 });
    if (u.includes("apis/site/v2/sports/")) return new Response(JSON.stringify({ events: [] }), { status: 200 });
    if (u.includes("supabase.co")) {
      if (init?.method && init.method !== "GET") {
        if (u.includes("game_judgments")) writes.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      return new Response("[]", { status: 200 });
    }
    throw new Error(`network blocked in test: ${u}`);
  }) as any;
  const executeWorkflowFn = vi.fn(async (_p: any) => ({ workflowId: "wf-1", finalAnalysis: reply }));
  const result = await runMorningSlate({
    dateInput: "2026-10-15",
    env: { GEMINI_API_KEY: "k", SUPABASE_URL: "https://mock.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s", ...env },
    fetchFn,
    executeWorkflowFn: executeWorkflowFn as any,
    claims: createMorningClaimStore(),
  });
  return { result, writes, instruction: executeWorkflowFn.mock.calls[0]?.[0]?.settings?.managerInstruction as string };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetMorningSingleFlight();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("JUDGMENT_FACTORS", () => {
  it("off (v2 on): v2 prompt has no factors and a factors reply is rejected as before", async () => {
    const { result, writes, instruction } = await run({ JUDGMENT_SCHEMA_V2: "1" }, WITH_FACTORS);
    expect(instruction).not.toContain("factors");
    expect(writes.filter((w) => w.schema_version === 2 && w.proj_margin === 4)).toHaveLength(0);
    expect(result.errors[0]?.error).toContain("rejected (schema)");
  });

  it("on (v2 on): prompt lists the registry ids and a valid factors reply is written", async () => {
    const { result, writes, instruction } = await run({ JUDGMENT_SCHEMA_V2: "1", JUDGMENT_FACTORS: "1" }, WITH_FACTORS);
    expect(instruction).toContain('"factors"');
    expect(instruction).toContain("inj_qb_out");
    expect(result.errors).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ schema_version: 2, proj_margin: 4, side: "home" });
  });

  it("on without v2: v1 prompt, flag ignored", async () => {
    const { instruction } = await run({ JUDGMENT_FACTORS: "1" }, JSON.stringify(V2));
    expect(instruction).toContain('"winProbHome"');
    expect(instruction).not.toContain("factors");
  });

  it("on: a factor for the wrong sport is rejected (factor_invalid)", async () => {
    const reply = JSON.stringify({ ...V2, factors: [{ id: "rest_b2b", evidence: { kind: "espn_field", ref: "schedule" } }] });
    const { result } = await run({ JUDGMENT_SCHEMA_V2: "1", JUDGMENT_FACTORS: "1" }, reply);
    expect(result.errors[0]?.error).toContain("rejected (factor_invalid)");
  });
});
