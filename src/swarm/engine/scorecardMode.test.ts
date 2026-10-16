import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeSwarmWorkflow } from "./index.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import {
  globalTokenBudgetManager,
  globalSpecialistProfiler,
  globalNodeCapacityManager,
} from "../loadBalancer.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";
import { renderScorecardManagerPrompt } from "./scorecardManager.ts";
import { renderCriticPrompt } from "./scorecardCritic.ts";

const SENTINEL = "SENTINEL-ROW-ZZZ";
const HEADER = "id|event|pick|mkt|line|odds|fairP|modelP|ev";
const ROWS = Array.from({ length: 60 }, (_, k) => {
  const id = `R${k + 1}`;
  if (id === "R39")
    return `R39|${SENTINEL} @ NOWHERE 10-16 20:00|X|ml|-|+100|0.500|0.500|0.0`;
  return `${id}|Team${k} @ Team${k + 100} 10-16 19:${String(k % 60).padStart(2, "0")}|Team${k}|ml|-|-110|0.512|0.530|1.${k % 10}`;
});
const DATA = [
  "Board legend: id=row id, mkt=market, fairP=no-vig probability",
  HEADER,
  ...ROWS,
].join("\n");

const calls: Record<string, { prompts: string[]; configs: any[] }> = {};
function track(name: string, prompt: string, config: any) {
  calls[name] ||= { prompts: [], configs: [] };
  calls[name].prompts.push(prompt);
  calls[name].configs.push(config);
}

const GOOD_CARD = {
  seat: "whatever",
  picks: [{ row: "R3", note: "price moved 12c" }, { row: "R7" }],
  parlay: { rows: ["R3", "R12"], targetFit: "in" },
  edge: 2.5,
  key_risk: "Bullpen usage last 3 days",
  confidence: 0.6,
  status: "ok",
};

const MANAGER = {
  id: "manager",
  role: "Manager Node",
  provider: "sc-manager-mock",
  apiKey: "k",
  model: "m",
};
const GOOD = {
  id: "good",
  role: "Line Analyst",
  provider: "sc-good-mock",
  apiKey: "k",
  model: "m",
};
const BAD = {
  id: "bad",
  role: "Rambling Analyst",
  provider: "sc-bad-mock",
  apiKey: "k",
  model: "m",
};
const CRITIC = {
  id: "critic",
  role: "Scorecard Critic",
  provider: "sc-critic-mock",
  apiKey: "k",
  model: "m",
};

const run = (
  appId: string,
  extra: Record<string, any> = {},
  scorecardMode = true,
  stages: any[] = [],
) =>
  executeSwarmWorkflow({
    task: "Build a 3-leg parlay from the board (target +600)",
    data: DATA,
    forceFullSwarm: true,
    bypassCache: true,
    enableDeepAnalysis: false,
    scorecardMode,
    onStage: (s: any) => stages.push(s),
    settings: {
      appId,
      agents: [MANAGER, GOOD, BAD],
      disableFallback: true,
      ...extra,
    },
  } as any);

describe("R2 scorecard mode end-to-end (executeSwarmWorkflow)", () => {
  beforeEach(() => {
    for (const k of Object.keys(calls)) delete calls[k];
    globalTokenBudgetManager.reset();
    globalSpecialistProfiler.reset();
    globalNodeCapacityManager.reset();
    globalProviderLimiter.reset();
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    ProviderRegistry.register({
      providerName: "sc-good-mock",
      async call(o: any) {
        track("good", o.prompt, o.config);
        if (o.prompt.includes("OUTPUT FORMAT (scorecard mode"))
          return JSON.stringify(GOOD_CARD);
        return JSON.stringify({
          insights: ["classic insight"],
          anomalies: [],
          summary: "classic summary",
        });
      },
    } as any);
    ProviderRegistry.register({
      providerName: "sc-bad-mock",
      async call(o: any) {
        track("bad", o.prompt, o.config);
        return JSON.stringify({
          thoughts: "I like the Yankees a lot because ".repeat(40),
        });
      },
    } as any);
    ProviderRegistry.register({
      providerName: "sc-critic-mock",
      async call(o: any) {
        track("critic", o.prompt, o.config);
        return JSON.stringify({
          ...GOOD_CARD,
          row_risks: [
            { row: "R3", key_risk: "line is stale" },
            { row: "R12", key_risk: "weather" },
          ],
        });
      },
    } as any);
    ProviderRegistry.register({
      providerName: "sc-manager-mock",
      async call(o: any) {
        track("manager", o.prompt, o.config);
        return JSON.stringify({
          ui_title: "Parlay",
          summary: "Legs R3 + R7 + R12.",
          components: [],
        });
      },
    } as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalProviderLimiter.reset();
  });

  it('analysts end with the schema + "JSON only" at maxTokens 800; the blackboard comes back with citedRows', async () => {
    const stages: any[] = [];
    const result: any = await run("r2-e2e-basic", {}, true, stages);

    const goodPrompt = calls.good.prompts[0];
    expect(goodPrompt.trimEnd().endsWith("JSON only.")).toBe(true);
    expect(calls.good.configs[0].maxTokens).toBe(800);
    expect(calls.good.configs[0].maxTokensCap).toBe(800);

    const bb = result.blackboard;
    expect(bb).toBeTruthy();
    expect(bb.brief).toContain("3-leg parlay");
    expect(bb.scorecards.find((s: any) => s.seat === "good")).toMatchObject({
      seat: "good",
      edge: 2.5,
    });
    expect(bb.scorecards.find((s: any) => s.seat === "bad")).toMatchObject({
      unstructured: true,
    });
    expect(bb.citedRows.map((r: any) => r.row)).toEqual(["R3", "R7", "R12"]);
    expect(bb.citedRows[0].line).toBe(ROWS[2]);
    expect(bb.header).toBe(HEADER);

    // The bad seat got exactly one repair, then became unstructured + degraded (run is still complete).
    expect(calls.bad.prompts.length).toBe(2);
    expect(result.degraded).toContain("bad");
    expect(bb.degraded).toContain("bad");
    expect(result.status).toBe("complete");

    // One swarm_stage 'scorecard' frame per seat.
    const frames = stages.filter((s) => s.stage === "scorecard");
    expect(frames.map((f) => f.seat).sort()).toEqual(["bad", "good"]);
    expect(frames.find((f) => f.seat === "good").scorecard.picks.length).toBe(
      2,
    );
  });

  it("the manager never gets the full data: no sentinel row, short prompt, cited rows only", async () => {
    const result: any = await run("r2-e2e-manager");
    const managerPrompt = calls.manager.prompts[0];
    expect(managerPrompt).not.toContain(SENTINEL);
    expect(managerPrompt).not.toContain(ROWS[49]); // an uncited row
    expect(managerPrompt).toContain(ROWS[2]); // R3, cited
    expect(managerPrompt).toContain(HEADER);
    expect(managerPrompt).toContain("row id");
    expect(managerPrompt.length).toBeLessThan(DATA.length / 2);
    expect(managerPrompt).not.toContain("Analyst Reports:");
    expect(result.finalAnalysis.ui_title).toBe("Parlay");
    expect(managerPrompt).toBe(renderScorecardManagerPrompt(result.blackboard));
  });

  it("deep analysis: the critic sees brief + scorecards + citedRows only and its scorecard reaches the manager", async () => {
    const stages: any[] = [];
    const result: any = await executeSwarmWorkflow({
      task: "Build a 3-leg parlay from the board (target +600)",
      data: DATA,
      forceFullSwarm: true,
      bypassCache: true,
      enableDeepAnalysis: true,
      scorecardMode: true,
      onStage: (s: any) => stages.push(s),
      settings: {
        appId: "r2-e2e-critic",
        agents: [MANAGER, GOOD],
        critic: CRITIC,
        disableFallback: true,
      },
    } as any);
    const criticPrompt = calls.critic.prompts[0];
    expect(criticPrompt).not.toContain(SENTINEL);
    expect(criticPrompt).toContain(ROWS[11]); // R12 (parlay leg)
    expect(criticPrompt.trimEnd().endsWith("JSON only.")).toBe(true);
    expect(result.blackboard.critic.row_risks.map((r: any) => r.row)).toEqual([
      "R3",
      "R12",
    ]);
    expect(calls.manager.prompts[0]).toContain("line is stale");
    expect(calls.manager.prompts.length).toBe(1); // no verification loop in scorecard mode
    expect(criticPrompt).toBe(
      renderCriticPrompt({ ...result.blackboard, critic: undefined }),
    );
    expect(stages.some((s) => s.stage === "critic_scorecard")).toBe(true);
  });

  it("a dead manager still returns the PS1 partial answer, with the blackboard", async () => {
    ProviderRegistry.register({
      providerName: "sc-manager-mock",
      async call() {
        throw new Error("Mock API Error (400): manager down");
      },
    } as any);
    const result: any = await run("r2-e2e-partial");
    expect(result.status).toBe("partial");
    expect(result.finalAnalysis.partial).toBe(true);
    expect(result.blackboard.degraded).toEqual(
      expect.arrayContaining(["bad", "manager"]),
    );
  });

  it("requests without scorecardMode are unchanged (classic prompts, no blackboard)", async () => {
    const stages: any[] = [];
    const result: any = await run("r2-e2e-classic", {}, false, stages);
    expect(result.blackboard).toBeUndefined();
    expect(calls.good.prompts[0]).not.toContain(
      "OUTPUT FORMAT (scorecard mode",
    );
    expect(calls.good.configs[0].maxTokensCap).toBeUndefined();
    expect(calls.manager.prompts[0]).toContain("Analyst Reports:");
    expect(stages.some((s) => s.stage === "scorecard")).toBe(false);
  });

  it("morning_judge runs ignore scorecardMode", async () => {
    const result: any = await run(
      "r2-e2e-morning",
      { responseSchema: "morning_judge" },
      true,
    );
    expect(result.blackboard).toBeUndefined();
    expect(calls.good.prompts[0]).not.toContain(
      "OUTPUT FORMAT (scorecard mode",
    );
  });
});
