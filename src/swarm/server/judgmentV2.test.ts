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
