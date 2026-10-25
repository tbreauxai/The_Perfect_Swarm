import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseAndValidateJudgmentV2,
  isJudgmentSchemaV2,
  sideEvColumn,
  JUDGMENT_TOTAL_RANGES,
} from "../morning/judgment.ts";
import { JUDGE_TOTAL_RANGES } from "../morning/judgePrompt.ts";

const fx = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../morning/judgment.v2.fixtures.json", import.meta.url),
    ),
    "utf8",
  ),
);

describe("judgment v2 shared fixtures", () => {
  for (const c of fx.valid) {
    it(`valid: ${c.name}`, () => {
      const r = parseAndValidateJudgmentV2(c.raw, fx.ids, c.market);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) {
        expect(r.judgment.eventId).toBe(fx.ids.eventId);
        expect(r.judgment.sport).toBe(fx.ids.sport);
        expect(r.judgment.schemaVersion).toBe(2);
      }
    });
  }
  for (const c of fx.invalid) {
    it(`invalid (${c.reason}): ${c.name}`, () => {
      const r = parseAndValidateJudgmentV2(c.raw, fx.ids, c.market);
      expect(r.ok).toBe(false);
      expect((r as any).reason).toBe(c.reason);
    });
  }
  for (const c of fx.sideEvColumn) {
    it(`sideEvColumn(${c.side}) = ${c.column}`, () => {
      expect(sideEvColumn(c.side)).toBe(c.column);
    });
  }
});

describe("judgment v2 helpers", () => {
  it("reads a fenced or nested reply", () => {
    const body = {
      side: "home",
      projMargin: 3,
      projTotal: 47,
      totalLean: "pass",
      confidence: 0.5,
      reasons: ["r"],
    };
    expect(
      parseAndValidateJudgmentV2(
        "```json\n" + JSON.stringify(body) + "\n```",
        fx.ids,
      ).ok,
    ).toBe(true);
    expect(
      parseAndValidateJudgmentV2(
        { finalAnalysis: JSON.stringify(body) },
        fx.ids,
      ).ok,
    ).toBe(true);
  });
  it("total range table matches JUDGE_TOTAL_RANGES", () => {
    expect(JUDGMENT_TOTAL_RANGES).toEqual(JUDGE_TOTAL_RANGES);
  });
  it("JUDGMENT_SCHEMA_V2 is off unless 1/true", () => {
    expect(isJudgmentSchemaV2({})).toBe(false);
    expect(isJudgmentSchemaV2(undefined)).toBe(false);
    expect(isJudgmentSchemaV2({ JUDGMENT_SCHEMA_V2: "0" })).toBe(false);
    expect(isJudgmentSchemaV2({ JUDGMENT_SCHEMA_V2: "yes" })).toBe(false);
    expect(isJudgmentSchemaV2({ JUDGMENT_SCHEMA_V2: "1" })).toBe(true);
    expect(isJudgmentSchemaV2({ JUDGMENT_SCHEMA_V2: "TRUE" })).toBe(true);
  });
});

import {
  buildProposerPrompt,
  buildProposerPromptV2,
  JUDGE_MANAGER_INSTRUCTION,
  JUDGE_MANAGER_INSTRUCTION_V2,
} from "../morning/judgePrompt.ts";

describe("judgment v2 prompts", () => {
  const game: any = { eventId: "e", sport: "americanfootball_nfl", homeTeam: "H", awayTeam: "A", commenceTime: "t" };
  it("proposer v2 asks for no probabilities; v1 unchanged", () => {
    expect(buildProposerPrompt(game)).toContain("win probability");
    const v2 = buildProposerPromptV2(game);
    expect(v2).not.toContain("win probability");
    expect(v2).toContain("project the final margin");
  });
  it("manager v2 is no longer than v1 and asks for the v2 keys only", () => {
    expect(JUDGE_MANAGER_INSTRUCTION_V2.length).toBeLessThanOrEqual(JUDGE_MANAGER_INSTRUCTION.length);
    for (const k of ["projMargin", "projTotal", "side", "totalLean", "confidence", "reasons"]) {
      expect(JUDGE_MANAGER_INSTRUCTION_V2).toContain(`"${k}"`);
    }
    expect(JUDGE_MANAGER_INSTRUCTION_V2).not.toContain('"winProbHome"');
    expect(JUDGE_MANAGER_INSTRUCTION_V2).not.toContain('"fairSpread"');
  });
});

import { parseAndValidateJudgeOutputV2 } from "../morning/judgePrompt.ts";
import { vi } from "vitest";

describe("parseAndValidateJudgeOutputV2", () => {
  const game: any = {
    eventId: "e9", sport: "americanfootball_nfl", homeTeam: "H", awayTeam: "A", commenceTime: "t",
    oddsSnapshot: { spread: -3, overUnder: 45 },
  };
  it("accepts a coherent reply with the game's ids and market", () => {
    const r = parseAndValidateJudgeOutputV2(
      { finalAnalysis: JSON.stringify({ side: "home", projMargin: 4, projTotal: 46, totalLean: "over", confidence: 0.6, reasons: ["r"] }) },
      game,
    );
    expect(r.ok).toBe(true);
    expect((r as any).judgment.eventId).toBe("e9");
  });
  it("rejects a v1 reply (winProbHome) and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = parseAndValidateJudgeOutputV2(JSON.stringify({ winProbHome: 0.6, fairSpread: -3 }), game);
    expect(r.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it("rejects a margin 11 off the market spread", () => {
    const r = parseAndValidateJudgeOutputV2(
      JSON.stringify({ side: "home", projMargin: 14, projTotal: 46, totalLean: "over", confidence: 0.6, reasons: ["r"] }),
      game,
    );
    expect((r as any).reason).toBe("margin_vs_market");
  });
});

import { computeModelSnapshot, computeModelSnapshotV2 } from "../morning/judgePrompt.ts";

describe("computeModelSnapshotV2", () => {
  const j: any = { schemaVersion: 2, eventId: "e", sport: "x", side: "away", projMargin: -6, projTotal: 51, totalLean: "pass", confidence: 0.4, reasons: ["r"] };
  it("stores the judge's projections, no fallbacks, no win prob", () => {
    const s = computeModelSnapshotV2(j, ["Quant Proposer"]);
    expect(s).toEqual({ projected_margin: -6, projected_total: 51, derived_from: "swarm_judgment_v2", participating_seats: ["Quant Proposer"] });
  });
  it("v1 snapshot is unchanged (fallbacks kept for flag off)", () => {
    const s = computeModelSnapshot({ eventId: "e" } as any, 0.6);
    expect(s.projected_margin).toBe(3.5);
    expect(s.projected_total).toBe(44.5);
  });
});
