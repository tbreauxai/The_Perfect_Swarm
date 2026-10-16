import { describe, it, expect } from "vitest";
import { AnalystScorecardSchema, CriticScorecardSchema } from "../types.ts";
import {
  isScorecardMode,
  scorecardAnalystMaxTokens,
  renderScorecardInstruction,
  validateScorecard,
  runScorecardSeat,
  scorecardToAnalystReport,
  SCORECARD_UNSTRUCTURED_MAX_CHARS,
} from "./scorecard.ts";
import { getDegraded } from "./partialResult.ts";
import { SwarmContext } from "../context.ts";

const VALID = {
  seat: "a1",
  picks: [{ row: "R12", note: "steam toward the home side" }, { row: "R40" }],
  parlay: { rows: ["R12", "R40"], targetFit: "near" },
  edge: 3.4,
  key_risk: "Starter is a late scratch risk",
  confidence: 0.61,
  status: "ok",
};

function fakeAgent(replies: Array<unknown | Error>) {
  const prompts: string[] = [];
  const configs: any[] = [];
  let i = 0;
  return {
    prompts,
    configs,
    agent: {
      role: "Test Analyst",
      provider: "fake-mock",
      modelName: "fake-model",
      async run(prompt: string, _ctx: any, config: any) {
        prompts.push(prompt);
        configs.push(config);
        const r = replies[Math.min(i++, replies.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    } as any,
  };
}

describe("R2-S1 AnalystScorecard schema", () => {
  it("accepts a valid scorecard and a no_play scorecard", () => {
    expect(AnalystScorecardSchema.safeParse(VALID).success).toBe(true);
    expect(
      AnalystScorecardSchema.safeParse({
        seat: "s",
        picks: [],
        edge: 0,
        key_risk: "",
        confidence: 0,
        status: "no_play",
      }).success,
    ).toBe(true);
  });

  it("rejects > 8 picks, a note > 60 chars, a bad row id, confidence > 1, a bad status and a string edge", () => {
    const nine = Array.from({ length: 9 }, (_, k) => ({ row: `R${k + 1}` }));
    expect(
      AnalystScorecardSchema.safeParse({ ...VALID, picks: nine }).success,
    ).toBe(false);
    expect(
      AnalystScorecardSchema.safeParse({
        ...VALID,
        picks: [{ row: "R1", note: "x".repeat(61) }],
      }).success,
    ).toBe(false);
    expect(
      AnalystScorecardSchema.safeParse({
        ...VALID,
        picks: [{ row: "Yankees ML" }],
      }).success,
    ).toBe(false);
    expect(
      AnalystScorecardSchema.safeParse({ ...VALID, confidence: 1.2 }).success,
    ).toBe(false);
    expect(
      AnalystScorecardSchema.safeParse({ ...VALID, status: "maybe" }).success,
    ).toBe(false);
    expect(
      AnalystScorecardSchema.safeParse({ ...VALID, edge: "3.4%" }).success,
    ).toBe(false);
    expect(
      AnalystScorecardSchema.safeParse({ ...VALID, key_risk: "k".repeat(121) })
        .success,
    ).toBe(false);
  });

  it("critic scorecard = analyst scorecard + row_risks (max 30)", () => {
    expect(
      CriticScorecardSchema.safeParse({
        ...VALID,
        seat: "critic",
        row_risks: [{ row: "R12", key_risk: "thin line" }],
      }).success,
    ).toBe(true);
    const tooMany = Array.from({ length: 31 }, (_, k) => ({
      row: `R${k + 1}`,
      key_risk: "r",
    }));
    expect(
      CriticScorecardSchema.safeParse({ ...VALID, row_risks: tooMany }).success,
    ).toBe(false);
  });

  it("scorecardMode is opt-in and never applies to morning_judge; analyst maxTokens defaults to 800", () => {
    expect(isScorecardMode({}, {})).toBe(false);
    expect(isScorecardMode({ scorecardMode: true }, {})).toBe(true);
    expect(isScorecardMode({}, { scorecardMode: true } as any)).toBe(true);
    expect(
      isScorecardMode({ scorecardMode: true }, {
        responseSchema: "morning_judge",
      } as any),
    ).toBe(false);
    expect(scorecardAnalystMaxTokens(undefined)).toBe(800);
    expect(
      scorecardAnalystMaxTokens({ scorecardAnalystMaxTokens: 450 } as any),
    ).toBe(450);
  });

  it('the instruction ends with "JSON only." and names the seat', () => {
    const text = renderScorecardInstruction("seat-x");
    expect(text.trimEnd().endsWith("JSON only.")).toBe(true);
    expect(text).toContain('"seat":"seat-x"');
  });
});

describe("R2-S2 validation and repair", () => {
  it("validateScorecard uses parseJsonSafe (fenced JSON) and code owns the seat id", () => {
    const fence = "`".repeat(3);
    const v = validateScorecard(
      `${fence}json\n${JSON.stringify({ ...VALID, seat: "model-made-this-up" })}\n${fence}`,
      "a1",
    );
    expect(v.ok).toBe(true);
    expect((v.scorecard as any).seat).toBe("a1");
  });

  it("a valid first reply needs no repair", async () => {
    const f = fakeAgent([VALID]);
    const ctx = new SwarmContext();
    const r = await runScorecardSeat({
      agent: f.agent,
      seat: "a1",
      prompt: "P",
      context: ctx,
      runConfig: { maxTokens: 800 },
    });
    expect(r.scorecard?.picks.length).toBe(2);
    expect(r.repaired).toBe(false);
    expect(f.prompts.length).toBe(1);
    expect(getDegraded(ctx)).toEqual([]);
  });

  it("an invalid reply gets exactly one repair on the same seat, with the validation error", async () => {
    const f = fakeAgent([{ ...VALID, confidence: 7 }, VALID]);
    const ctx = new SwarmContext();
    const r = await runScorecardSeat({
      agent: f.agent,
      seat: "a1",
      prompt: "P",
      context: ctx,
      runConfig: { maxTokens: 800 },
    });
    expect(r.repaired).toBe(true);
    expect(r.scorecard?.confidence).toBe(0.61);
    expect(f.prompts.length).toBe(2);
    expect(f.prompts[1]).toContain("confidence");
    expect(f.configs[1].bypassCache).toBe(true);
    expect(f.configs[1].maxTokens).toBe(800);
    expect(getDegraded(ctx)).toEqual([]);
  });

  it("still invalid after the repair -> unstructured (<= 600 chars) and the seat is degraded, never throws", async () => {
    const long = { essay: "x".repeat(2000) };
    const f = fakeAgent([long, long]);
    const ctx = new SwarmContext();
    const r = await runScorecardSeat({
      agent: f.agent,
      seat: "a1",
      prompt: "P",
      context: ctx,
      runConfig: {},
    });
    expect(f.prompts.length).toBe(2);
    expect(r.scorecard).toBeUndefined();
    expect(r.unstructured!.length).toBe(SCORECARD_UNSTRUCTURED_MAX_CHARS);
    expect(getDegraded(ctx)).toEqual(["a1"]);
    const report = scorecardToAnalystReport(r, "Test Analyst");
    expect(report.unstructured).toBe(true);
    expect(report.summary.length).toBeLessThanOrEqual(600);
  });

  it("a repair call that throws keeps the first reply as unstructured text", async () => {
    const f = fakeAgent([
      { note: "first reply" },
      new Error("Mock API Error (400): down"),
    ]);
    const ctx = new SwarmContext();
    const r = await runScorecardSeat({
      agent: f.agent,
      seat: "a2",
      prompt: "P",
      context: ctx,
      runConfig: {},
    });
    expect(r.unstructured).toContain("first reply");
    expect(getDegraded(ctx)).toEqual(["a2"]);
  });

  it("a provider failure on the first call still throws (the PS1 failed-seat path handles it)", async () => {
    const f = fakeAgent([new Error("Mock API Error (400): down")]);
    await expect(
      runScorecardSeat({
        agent: f.agent,
        seat: "a3",
        prompt: "P",
        context: new SwarmContext(),
        runConfig: {},
      }),
    ).rejects.toThrow(/down/);
  });

  it("scorecardToAnalystReport keeps the engine report shape (insights / anomalies / summary)", () => {
    const report = scorecardToAnalystReport(
      { seat: "a1", scorecard: VALID as any, repaired: false },
      "Test Analyst",
    );
    expect(report.insights).toEqual([
      "R12: steam toward the home side",
      "R40",
      "Parlay R12 + R40 (target fit: near)",
    ]);
    expect(report.anomalies).toEqual([]);
    expect(report.summary).toContain("Edge 3.4%");
    expect(report.scorecard.seat).toBe("a1");
  });
});
