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
import { codeEdgeForPick } from "../engine/scorecard.ts";

const fx = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../morning/judgment.v2.fixtures.json", import.meta.url),
    ),
    "utf8",
  ),
);

// Fixtures are byte-identical to DuelOdds src/math/judgment.v2.fixtures.json (b264058f, "input" layout).
// The swarm owns eventId/sport/schemaVersion in code (parseJudgmentV2 overwrites them), so ids come
// from each case's input, with DuelOdds sport labels mapped to the swarm's odds-api sport keys.
const SPORT_KEY: Record<string, string> = { NFL: "americanfootball_nfl", NBA: "basketball_nba" };
function idsOf(input: unknown): { eventId: string; sport: string } {
  const o: any = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const sport = typeof o.sport === "string" ? o.sport : "NFL";
  return { eventId: typeof o.eventId === "string" ? o.eventId : "evt-1", sport: SPORT_KEY[sport] ?? sport };
}
const IDS = { eventId: "evt-1", sport: "americanfootball_nfl" };

// DuelOdds reports granular parse reasons; the swarm folds every rule-a (strict schema) failure into
// "schema" and names the no-market clamps margin_range/total_range. Logic is not changed here.
const SWARM_REASON: Record<string, string> = {
  not_json: "schema",
  not_object: "schema",
  extra_key: "schema",
  bad_side: "schema",
  bad_number: "schema",
  proj_total_nonpositive: "schema",
  bad_total_lean: "schema",
  bad_confidence: "schema",
  bad_reasons: "schema",
  total_out_of_range: "total_range",
  margin_out_of_range: "margin_range",
};

// SKIPPED: the swarm has no such rule, it overwrites code-owned ids instead of rejecting them.
const SKIP_INVALID = new Set(["bad_schema_version", "bad_event_id", "bad_sport"]);
// SKIPPED: the swarm's sideEvColumn has no spread columns (feature not in the swarm).
const SKIP_SIDES = new Set(["spread_home", "spread_away"]);
// SKIPPED: swarm codeEdgeForPick accepts finite numbers only; DuelOdds also reads numeric strings.
const SKIP_CODE_EDGE = new Set(["numeric string (PostgREST numeric)"]);

describe("judgment v2 shared fixtures", () => {
  for (const c of fx.valid) {
    it(`valid: ${c.name}`, () => {
      const ids = idsOf(c.input);
      const r = parseAndValidateJudgmentV2(c.input, ids, c.market);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) {
        expect(r.judgment.eventId).toBe(ids.eventId);
        expect(r.judgment.sport).toBe(ids.sport);
        expect(r.judgment.schemaVersion).toBe(2);
      }
    });
  }
  for (const c of fx.invalid) {
    const t = SKIP_INVALID.has(c.reason) ? it.skip : it;
    t(`invalid (${c.reason}): ${c.name}`, () => {
      const r = parseAndValidateJudgmentV2(c.input, idsOf(c.input), c.market);
      expect(r.ok).toBe(false);
      expect((r as any).reason).toBe(SWARM_REASON[c.reason] ?? c.reason);
    });
  }
  for (const c of fx.sideEvColumn) {
    const t = SKIP_SIDES.has(c.side) ? it.skip : it;
    t(`sideEvColumn(${c.side}) = ${c.column}`, () => {
      expect(sideEvColumn(c.side)).toBe(c.column);
    });
  }
  for (const c of fx.codeEdge) {
    const t = SKIP_CODE_EDGE.has(c.name) ? it.skip : it;
    t(`codeEdge: ${c.name}`, () => {
      expect(codeEdgeForPick(c.row, c.side, true)).toBe(c.edge);
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
        IDS,
      ).ok,
    ).toBe(true);
    expect(
      parseAndValidateJudgmentV2(
        { finalAnalysis: JSON.stringify(body) },
        IDS,
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
