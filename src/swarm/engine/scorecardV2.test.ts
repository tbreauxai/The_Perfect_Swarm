import { describe, it, expect, afterEach, vi } from "vitest";
import {
  renderScorecardInstruction,
  validateScorecard,
  scorecardToAnalystReport,
  codeEdgeForPick,
  scorecardV2,
} from "./scorecard.ts";
import { renderCriticPrompt } from "./scorecardCritic.ts";
import { CriticScorecardSchema } from "../types.ts";

/** S7 (JUDGMENT_SCHEMA_V2): scorecards drop the LLM edge; the code edge is the picked side's ev_* column. */
const card = {
  seat: "a1",
  picks: [{ row: "R3" }],
  edge: 4.2,
  key_risk: "k",
  confidence: 0.6,
  status: "ok",
};
const bb: any = { scorecards: [], citedRows: [], header: "" };

afterEach(() => vi.unstubAllEnvs());

describe("S7 flag on", () => {
  it("instructions ask for no edge", () => {
    expect(renderScorecardInstruction("a1", true)).not.toContain('"edge"');
    expect(renderCriticPrompt(bb, true)).not.toContain('"edge":');
  });
  it("a reply with edge validates and the edge is dropped (analyst and critic)", () => {
    const v = validateScorecard(JSON.stringify(card), "a1", undefined, true);
    expect(v.ok).toBe(true);
    expect(v.scorecard).not.toHaveProperty("edge");
    const c = validateScorecard(
      JSON.stringify({ ...card, row_risks: [] }),
      "critic",
      CriticScorecardSchema,
      true,
    );
    expect(c.ok).toBe(true);
    expect(c.scorecard).not.toHaveProperty("edge");
  });
  it("headline shows the code edge, or none when null", () => {
    const sc: any = { ...card };
    delete sc.edge;
    const r = { seat: "a1", scorecard: sc, repaired: false };
    expect(scorecardToAnalystReport(r, "Quant", 2.1, true).summary).toMatch(
      /^Code edge 2.1%/,
    );
    expect(scorecardToAnalystReport(r, "Quant", null, true).summary).toMatch(
      /^Play \|/,
    );
  });
  it("codeEdgeForPick reads ev_home/ev_away/ev_over/ev_under; null skips", () => {
    const row = {
      ev_home: 0.031,
      ev_away: -0.05,
      ev_over: null,
      ev_under: 0.012,
    };
    expect(codeEdgeForPick(row, "home", true)).toBe(0.031);
    expect(codeEdgeForPick(row, "away", true)).toBe(-0.05);
    expect(codeEdgeForPick(row, "over", true)).toBeNull();
    expect(codeEdgeForPick(row, "under", true)).toBe(0.012);
    expect(codeEdgeForPick(row, "pass", true)).toBeNull();
  });
  it("reads JUDGMENT_SCHEMA_V2 from process.env at call time", () => {
    vi.stubEnv("JUDGMENT_SCHEMA_V2", "true");
    expect(scorecardV2()).toBe(true);
    expect(renderScorecardInstruction("a1")).not.toContain('"edge"');
  });
});

describe("S7 flag off (default): unchanged", () => {
  it("instructions, validation and headline keep the LLM edge; no code edge", () => {
    vi.stubEnv("JUDGMENT_SCHEMA_V2", "");
    expect(renderScorecardInstruction("a1")).toContain('"edge":3.5');
    expect(renderCriticPrompt(bb)).toContain('"edge":1.5');
    const v = validateScorecard(JSON.stringify(card), "a1");
    expect(v.scorecard?.edge).toBe(4.2);
    expect(
      scorecardToAnalystReport(
        { seat: "a1", scorecard: v.scorecard, repaired: false },
        "Quant",
        9,
      ).summary,
    ).toMatch(/^Edge 4.2%/);
    expect(codeEdgeForPick({ ev_home: 0.03 }, "home")).toBeNull();
  });
});
