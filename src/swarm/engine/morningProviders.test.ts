import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyMorningProviderPolicy,
  MORNING_GROQ_JUDGE_MODEL,
} from "./morningProviders.ts";
import { buildDefaultAgents, runMorningSlate } from "../morning/index.ts";
import { executeSwarmWorkflow } from "./index.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { globalSemanticCache } from "../cache.ts";
import {
  globalTokenBudgetManager,
  globalSpecialistProfiler,
  globalNodeCapacityManager,
} from "../loadBalancer.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";

const ALL = {
  GEMINI_API_KEY: "g-key",
  GROQ_API_KEY: "gsk-key",
  OPENROUTER_API_KEY: "sk-or-v1-key",
  MISTRAL_API_KEY: "m-key",
};
const settingsFor = (env: Record<string, string>) =>
  ({
    responseSchema: "morning_judge",
    geminiApiKey: env.GEMINI_API_KEY,
    groqApiKey: env.GROQ_API_KEY,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    mistralApiKey: env.MISTRAL_API_KEY,
  }) as any;
const seats = (agents: any[]) =>
  agents.map((a) => `${a.id}:${a.provider}/${a.model}`);

describe("morning provider policy (Groq first, never OpenRouter)", () => {
  beforeEach(() => {
    for (const k of [
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "MISTRAL_API_KEY",
    ])
      vi.stubEnv(k, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("all keys: judge on Groq gpt-oss-120b, the OpenRouter critic moves to Groq gpt-oss-20b, a1/a2 unchanged", () => {
    const out = applyMorningProviderPolicy(
      buildDefaultAgents(ALL),
      settingsFor(ALL),
    );
    expect(seats(out)).toEqual([
      "a1:gemini/gemini-3.1-flash-lite",
      "a2:groq/openai/gpt-oss-120b",
      "critic:groq/openai/gpt-oss-20b",
      `manager:groq/${MORNING_GROQ_JUDGE_MODEL}`,
    ]);
    expect(out.some((a) => a.provider === "openrouter")).toBe(false);
  });

  it("no Groq key: critic goes to Mistral, the judge keeps Mistral", () => {
    const env = {
      GEMINI_API_KEY: "g",
      OPENROUTER_API_KEY: "sk-or-v1-x",
      MISTRAL_API_KEY: "m",
    };
    expect(
      seats(
        applyMorningProviderPolicy(buildDefaultAgents(env), settingsFor(env)),
      ),
    ).toEqual([
      "a1:gemini/gemini-3.1-flash-lite",
      "critic:mistral/mistral-small-latest",
      "manager:mistral/mistral-small-latest",
    ]);
  });

  it("OpenRouter + Gemini only: critic goes to Gemini; OpenRouter only: the critic seat is dropped", () => {
    const env1 = { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "sk-or-v1-x" };
    expect(
      seats(
        applyMorningProviderPolicy(buildDefaultAgents(env1), settingsFor(env1)),
      ),
    ).toEqual([
      "a1:gemini/gemini-3.1-flash-lite",
      "critic:gemini/gemini-3.1-flash-lite",
    ]);
    const env2 = { OPENROUTER_API_KEY: "sk-or-v1-x" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      applyMorningProviderPolicy(buildDefaultAgents(env2), settingsFor(env2)),
    ).toEqual([]);
  });
});

describe("morning run end to end: no OpenRouter call, even as a fallback; AI Lab still uses OpenRouter", () => {
  const calls: Array<{ provider: string; model: string; judge: boolean }> = [];
  let groqDown = false;

  function espnFetch(): typeof fetch {
    return vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/sports/football/nfl/")) {
        return new Response(
          JSON.stringify({
            events: [
              {
                id: "nfl-1",
                date: "2026-10-18T17:00:00Z",
                competitions: [
                  {
                    competitors: [
                      {
                        homeAway: "home",
                        team: { displayName: "Kansas City Chiefs" },
                      },
                      {
                        homeAway: "away",
                        team: { displayName: "Denver Broncos" },
                      },
                    ],
                    odds: [
                      { details: "KC -6.5", spread: -6.5, overUnder: 44.5 },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as any;
  }

  beforeEach(() => {
    calls.length = 0;
    groqDown = false;
    globalSemanticCache.clear();
    globalTokenBudgetManager.reset();
    globalSpecialistProfiler.reset();
    globalNodeCapacityManager.reset();
    globalProviderLimiter.reset();
    for (const k of [
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "MISTRAL_API_KEY",
    ])
      vi.stubEnv(k, "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`unexpected network call in test: ${url}`);
      }),
    );
    ProviderRegistry.list();
    for (const providerName of ["gemini", "groq", "openrouter", "mistral"]) {
      ProviderRegistry.register({
        providerName,
        async call(o: any) {
          const sys = String(o.systemInstruction || "");
          const judge =
            sys.includes("Morning Swarm Judge") ||
            sys.includes("Swarm Orchestrator");
          calls.push({ provider: providerName, model: o.modelName, judge });
          if (providerName === "groq" && groqDown)
            throw new Error("[RATE_LIMIT_429] Groq rate limit");
          if (!judge)
            return JSON.stringify({
              insights: ["KC rested"],
              anomalies: [],
              summary: "lean KC",
            });
          if (sys.includes("Morning Swarm Judge")) {
            return JSON.stringify({
              likelyWinner: "Kansas City Chiefs",
              winProbHome: 0.66,
              winProbAway: 0.34,
              fairSpread: -6,
              fairTotal: 44,
              totalLean: "none",
              arguments: [],
              invalidationConditions: [],
            });
          }
          return JSON.stringify({
            ui_title: "Call",
            summary: "Lean KC.",
            components: [],
          });
        },
      } as any);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalProviderLimiter.reset();
  });

  it("all four keys: the judge call is on Groq gpt-oss-120b and nothing calls OpenRouter", async () => {
    const result = await runMorningSlate({
      dateInput: "2026-10-18",
      env: { ...ALL },
      fetchFn: espnFetch(),
    });
    expect(result.judged).toBe(1);
    expect(calls.filter((c) => c.provider === "openrouter")).toEqual([]);
    expect(calls.find((c) => c.judge)).toMatchObject({
      provider: "groq",
      model: MORNING_GROQ_JUDGE_MODEL,
    });
    expect(
      calls.some(
        (c) =>
          !c.judge && c.provider === "groq" && c.model === "openai/gpt-oss-20b",
      ),
    ).toBe(true);
  });

  it("Groq down (429): seats and the judge fall back to Mistral/Gemini, never OpenRouter", async () => {
    groqDown = true;
    const result = await runMorningSlate({
      dateInput: "2026-10-18",
      env: { ...ALL },
      fetchFn: espnFetch(),
    });
    expect(result.judged).toBe(1);
    expect(calls.filter((c) => c.provider === "openrouter")).toEqual([]);
    const judgeCalls = calls.filter((c) => c.judge);
    expect(judgeCalls[0].provider).toBe("groq");
    expect(
      judgeCalls.some(
        (c) => c.provider === "gemini" || c.provider === "mistral",
      ),
    ).toBe(true);
  });

  it("AI Lab (no morning_judge) keeps its OpenRouter seat", async () => {
    await executeSwarmWorkflow({
      task: "Build a parlay",
      data: "id|event|pick\nR1|DEN @ KC|KC",
      forceFullSwarm: true,
      bypassCache: true,
      enableDeepAnalysis: false,
      settings: {
        appId: "ailab-test",
        openRouterApiKey: ALL.OPENROUTER_API_KEY,
        geminiApiKey: ALL.GEMINI_API_KEY,
        disableFallback: true,
        agents: [
          {
            id: "manager",
            role: "Manager Node",
            provider: "gemini",
            model: "gemini-2.5-flash",
          },
          {
            id: "critic",
            role: "Risk Critic",
            provider: "openrouter",
            model: "nvidia/nemotron-3-super-120b-a12b:free",
          },
        ],
      },
    } as any);
    expect(calls.some((c) => c.provider === "openrouter")).toBe(true);
  });
});
