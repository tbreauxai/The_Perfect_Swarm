import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeSwarmWorkflow } from "./index.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { GroqAdapter } from "../providers/groq.ts";
import {
  globalTokenBudgetManager,
  globalSpecialistProfiler,
  globalNodeCapacityManager,
} from "../loadBalancer.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";

const goodReport = (tag: string) =>
  JSON.stringify({
    insights: [`${tag} insight one`, `${tag} insight two`],
    anomalies: [],
    summary: `${tag} summary`,
    ui_title: `${tag} title`,
    components: [],
  });

let groqPoolCalls = 0;

const run = (appId: string, agents: any[], extra: Record<string, any> = {}) =>
  executeSwarmWorkflow({
    task: `PS1 test ${appId}: evaluate the matchup`,
    data: `short payload for a single chunk (${appId})`,
    forceFullSwarm: true,
    bypassCache: true,
    settings: { appId, agents, ...extra },
  } as any);

const MANAGER_OK = {
  id: "manager",
  role: "Manager Node",
  provider: "ps-ok-mock",
  apiKey: "k-mgr",
  model: "mock-mgr",
};
const MANAGER_DEAD = {
  id: "manager",
  role: "Manager Node",
  provider: "ps-dead-mock",
  apiKey: "k-mgr",
  model: "mock-mgr",
};
const GOOD = {
  id: "good",
  role: "Good Analyst",
  provider: "ps-ok-mock",
  apiKey: "k-good",
  model: "mock-good",
};
const BAD = {
  id: "bad",
  role: "Dead Analyst",
  provider: "ps-dead-mock",
  apiKey: "k-bad",
  model: "mock-bad",
};

describe("PS1 partial / degraded semantics", () => {
  beforeEach(() => {
    globalTokenBudgetManager.reset();
    globalSpecialistProfiler.reset();
    globalNodeCapacityManager.reset();
    globalProviderLimiter.reset();
    groqPoolCalls = 0;

    // Only Groq has a server key, so the global pool / manager chain = [groq] and no real network is reachable.
    // (github is no longer a provider in the chain or the pool, so GITHUB_TOKEN doesn't matter here.)
    vi.stubEnv("GROQ_API_KEY", "gsk_test_key");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    ProviderRegistry.register({
      providerName: "ps-ok-mock",
      async call(options: any) {
        return goodReport(options.role || "ok");
      },
    } as any);
    // 400 is treated as fatal by Agent.run, so these fail instantly with no backoff wait.
    ProviderRegistry.register({
      providerName: "ps-dead-mock",
      async call() {
        throw new Error("Mock API Error (400): provider down everywhere");
      },
    } as any);
    // Stand-in for the pooled Groq fallback (counts every borrow).
    ProviderRegistry.register({
      providerName: "groq",
      async call(options: any) {
        groqPoolCalls++;
        return goodReport(`groq-fallback ${options.role || ""}`);
      },
    } as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    ProviderRegistry.register(new GroqAdapter());
    globalProviderLimiter.reset();
  });

  it("a seat that fails with no backup is degraded, but the run stays complete", async () => {
    const result: any = await run("ps1-degraded", [MANAGER_OK, GOOD, BAD], {
      disableFallback: true,
    });
    expect(result.status).toBe("complete");
    expect(result.partial).toBe(false);
    expect(result.degraded).toEqual(["bad"]);
    expect(result.finalAnalysis?.partial).not.toBe(true);
    expect(result.workflowId).toBeTruthy();
  });

  it("a seat that recovers through a fallback is neither partial nor degraded", async () => {
    const result: any = await run("ps1-recovered", [MANAGER_OK, GOOD, BAD]);
    expect(groqPoolCalls).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe("complete");
    expect(result.partial).toBe(false);
    expect(result.degraded).toEqual([]);
    expect(result.workflowId).toBeTruthy();
  });

  it("an all-dead manager chain returns the best analyst output with partial:true", async () => {
    const result: any = await run("ps1-manager-dead", [MANAGER_DEAD, GOOD], {
      disableFallback: true,
    });
    expect(result.status).toBe("partial");
    expect(result.partial).toBe(true);
    expect(result.finalAnalysis.partial).toBe(true);
    expect(result.finalAnalysis.sourceAnalyst.seatId).toBe("good");
    expect(result.degraded).toEqual(["manager"]);
    expect(result.workflowId).toBeTruthy();
  });

  it("zero analyst outputs is still a hard failure (swarm_error path)", async () => {
    await expect(
      run("ps1-all-dead", [MANAGER_OK, BAD], { disableFallback: true }),
    ).rejects.toThrow(/All analysts failed/);
  });

  it("morning runs never pull from the global analyst pool", async () => {
    const result: any = await run(
      "ps1-morning-no-pool",
      [MANAGER_OK, GOOD, BAD],
      { responseSchema: "morning_judge" },
    );
    expect(groqPoolCalls).toBe(0);
    expect(result.degraded).toEqual(["bad"]);
    expect(result.status).toBe("complete");
  });

  it("morning runs keep the PS1 partial fallback when the manager chain is dead", async () => {
    const result: any = await run("ps1-morning-partial", [MANAGER_DEAD, GOOD], {
      responseSchema: "morning_judge",
      disableFallback: true,
    });
    expect(result.status).toBe("partial");
    expect(result.partial).toBe(true);
    expect(result.finalAnalysis.partial).toBe(true);
  });
});
