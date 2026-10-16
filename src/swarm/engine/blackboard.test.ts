import { describe, it, expect } from "vitest";
import {
  buildBlackboard,
  buildCitedRows,
  collectCitedRowIds,
  indexTableRows,
  renderCitedRows,
} from "./blackboard.ts";

const DATA = [
  "[Calibration] recent hit rate 54%",
  "Board legend: id=row id, mkt=market, fairP=no-vig probability",
  "id|event|pick|mkt|line|odds|fairP|modelP|ev",
  "R1|NYY @ BOS 10-16 18:10|NYY|ml|-|-120|0.530|0.560|2.1",
  "R2|NYY @ BOS 10-16 18:10|BOS|ml|-|+102|0.470|0.440|-3.0",
  "R3|LAD @ SD 10-16 21:10|LAD|spread|-1.5|+140|0.400|0.430|1.8",
  "R12|LAD @ SD 10-16 21:10|over|total|8.5|-110|0.510|0.540|2.4",
  "R40|SEA @ HOU 10-16 19:05|HOU|ml|-|-150|0.590|0.610|1.0",
  "Not a row: R2D2 | droid",
  "R3|duplicate id later in the data|x|x|x|x|x|x|x",
].join("\n");

const agents: any[] = [
  { id: "a1", role: "Line Analyst" },
  { id: "a2", role: "Stats Analyst" },
  { id: "a3", role: "Broken Analyst" },
];

describe("R2-S3 blackboard and citedRows", () => {
  it("indexes row ids to their original table line (first occurrence) and the header above them", () => {
    const { lines, headers } = indexTableRows(DATA);
    expect(lines.get("R3")).toBe(
      "R3|LAD @ SD 10-16 21:10|LAD|spread|-1.5|+140|0.400|0.430|1.8",
    );
    expect(lines.has("R2D2")).toBe(false);
    expect(headers.get("R1")).toBe(
      "id|event|pick|mkt|line|odds|fairP|modelP|ev",
    );
  });

  it("citedRows = union of picks + parlay rows, de-duplicated, ordered by id, unknown ids split out", () => {
    const ids = collectCitedRowIds([
      {
        seat: "a1",
        role: "r",
        picks: [{ row: "R12" }, { row: "R3" }],
        parlay: { rows: ["R3", "R40"], targetFit: "in" },
        edge: 1,
        key_risk: "",
        confidence: 0.5,
        status: "ok",
      },
      {
        seat: "a2",
        role: "r",
        picks: [{ row: "R12" }, { row: "R99" }],
        edge: 1,
        key_risk: "",
        confidence: 0.5,
        status: "ok",
      },
      { seat: "a3", role: "r", unstructured: true, text: "R1 looks good" },
    ] as any);
    expect(ids).toEqual(["R3", "R12", "R40", "R99"]);
    const { citedRows, header, unknownRows } = buildCitedRows(DATA, ids);
    expect(citedRows.map((r) => r.row)).toEqual(["R3", "R12", "R40"]);
    expect(citedRows[1].line).toBe(
      "R12|LAD @ SD 10-16 21:10|over|total|8.5|-110|0.510|0.540|2.4",
    );
    expect(header).toBe("id|event|pick|mkt|line|odds|fairP|modelP|ev");
    expect(unknownRows).toEqual(["R99"]);
    expect(renderCitedRows({ citedRows, header }).split("\n")[0]).toBe(header);
  });

  it("buildBlackboard collects scorecards (structured and unstructured), degraded and citedRows", () => {
    const reports = [
      [
        {
          seat: "a1",
          scorecard: {
            seat: "a1",
            picks: [{ row: "R1" }],
            edge: 2,
            key_risk: "k",
            confidence: 0.6,
            status: "ok",
          },
          _chunkIndex: 0,
        },
      ],
      [
        {
          seat: "a2",
          scorecard: {
            seat: "a2",
            picks: [{ row: "R40", note: "n" }],
            edge: 1,
            key_risk: "k",
            confidence: 0.5,
            status: "ok",
          },
          _chunkIndex: 0,
        },
      ],
      [
        {
          seat: "a3",
          unstructured: true,
          summary: "free text only",
          _chunkIndex: 0,
        },
      ],
    ];
    const bb = buildBlackboard({
      brief: "Find a 3-leg parlay",
      data: DATA,
      analysts: agents,
      allAnalystReports: reports,
      degraded: ["a3"],
    });
    expect(bb.brief).toBe("Find a 3-leg parlay");
    expect(bb.scorecards.length).toBe(3);
    expect(bb.scorecards[2]).toMatchObject({
      seat: "a3",
      unstructured: true,
      text: "free text only",
    });
    expect(bb.citedRows.map((r) => r.row)).toEqual(["R1", "R40"]);
    expect(bb.degraded).toEqual(["a3"]);
    expect(bb.unknownRows).toEqual([]);
  });
});
