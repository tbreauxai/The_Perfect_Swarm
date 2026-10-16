import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildManagerChain,
  buildAnalystPool,
  mergeFallbacks,
  MANAGER_CHAIN,
} from "./managerChain.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";
import { DEFAULT_PROVIDER_MODELS } from "../agent.ts";
import { resolveSwarmAgents } from "./agentResolution.ts";

const ids = (list: Array<{ provider: any; modelName?: string }>) =>
  list.map((c) => `${c.provider}:${c.modelName}`);

describe("MANAGER_CHAIN + analyst pool (PS3)", () => {
  beforeEach(() => {
    globalProviderLimiter.reset();
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token"); // set on purpose: github must never appear (retired 2026-07-30)
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("MISTRAL_API_KEY", "mistral-test-key");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_key");
    vi.stubEnv("OPENROUTER_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalProviderLimiter.reset();
  });

  it("MANAGER_CHAIN is gemini-2.5-flash, gemini-2.5-flash-lite, mistral, groq (no github)", () => {
    expect(MANAGER_CHAIN.map((e) => `${e.provider}:${e.model}`)).toEqual([
      "gemini:gemini-2.5-flash",
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    expect(MANAGER_CHAIN.some((e) => String(e.provider) === "github")).toBe(
      false,
    );
  });

  it("keeps MANAGER_CHAIN order and only uses entries with a server key", () => {
    expect(ids(buildManagerChain())).toEqual([
      "gemini:gemini-2.5-flash",
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(buildManagerChain().map((c) => c.provider)).toEqual([
      "mistral",
      "groq",
    ]);
  });

  it("skips providers whose circuit is open and models marked dead", () => {
    // A dead model only removes that model: flash-lite stays.
    globalProviderLimiter.recordFailure(
      "gemini",
      "gemini-2.5-flash",
      "Gemini API Error (404): NOT_FOUND model",
    );
    expect(ids(buildManagerChain())).toEqual([
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    // An open circuit removes every entry for that provider.
    for (let i = 0; i < 3; i++)
      globalProviderLimiter.recordFailure(
        "gemini",
        "gemini-2.5-flash-lite",
        "[RATE_LIMIT_429] x",
      );
    globalProviderLimiter.recordFailure(
      "mistral",
      "mistral-small-latest",
      "Mistral API Error (404): model not found",
    );
    expect(buildManagerChain().map((c) => c.provider)).toEqual(["groq"]);
  });

  it("excludes the manager's own provider+model", () => {
    const chain = buildManagerChain(undefined, {
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(ids(chain)).toEqual([
      "gemini:gemini-2.5-flash-lite",
      "mistral:mistral-small-latest",
      "groq:openai/gpt-oss-120b",
    ]);
    const noMistral = buildManagerChain(undefined, { provider: "mistral" });
    expect(noMistral.map((c) => c.provider)).toEqual([
      "gemini",
      "gemini",
      "groq",
    ]);
  });

  it("analyst pool covers every keyed provider, using the default model when no seat uses it", () => {
    const pool = buildAnalystPool(
      ["gemini", "openrouter", "groq", "mistral"] as any,
      {} as any,
      [
        {
          id: "a1",
          role: "Analyst",
          provider: "groq",
          model: "openai/gpt-oss-20b",
        } as any,
      ],
    );
    expect(pool.map((p) => p.provider)).toEqual(["gemini", "groq", "mistral"]);
    expect(pool.find((p) => p.provider === "groq")?.modelName).toBe(
      "openai/gpt-oss-20b",
    );
    expect(pool.find((p) => p.provider === "gemini")?.modelName).toBe(
      DEFAULT_PROVIDER_MODELS.gemini,
    );
    expect(pool.find((p) => p.provider === "mistral")?.modelName).toBe(
      DEFAULT_PROVIDER_MODELS.mistral,
    );
  });

  it("morning runs never borrow from the global analyst pool (chat runs do, and never from github)", () => {
    const agents = [
      {
        id: "manager",
        role: "Manager Node",
        provider: "ps-ok-mock",
        apiKey: "k-mgr",
        model: "mock-mgr",
      },
      {
        id: "a1",
        role: "Analyst",
        provider: "ps-ok-mock",
        apiKey: "k-a1",
        model: "mock-a1",
      },
    ];
    const morning = resolveSwarmAgents(
      { responseSchema: "morning_judge", agents } as any,
      undefined,
    );
    expect(morning.analysts[0].getFallbacks()).toEqual([]);

    const chat = resolveSwarmAgents({ agents } as any, undefined);
    expect(chat.analysts[0].getFallbacks().map((f) => f.provider)).toEqual([
      "gemini",
      "groq",
      "mistral",
    ]);
    expect(
      chat.managerAgent.getFallbacks().map((f) => String(f.provider)),
    ).not.toContain("github");

    // Morning still keeps seat-model fallbacks (pre-PS3 behavior): a keyed provider that has a seat in the run.
    const morningWithSeat = resolveSwarmAgents(
      {
        responseSchema: "morning_judge",
        agents: [
          ...agents,
          {
            id: "g1",
            role: "Groq Seat",
            provider: "groq",
            model: "openai/gpt-oss-20b",
          },
        ],
      } as any,
      undefined,
    );
    expect(
      morningWithSeat.analysts[0]
        .getFallbacks()
        .map((f) => `${f.provider}:${f.modelName}`),
    ).toEqual(["groq:openai/gpt-oss-20b"]);
  });

  it("mergeFallbacks de-duplicates provider+model, keeping the first", () => {
    const merged = mergeFallbacks(
      [{ provider: "gemini", modelName: "a", apiKey: "k" } as any],
      [
        { provider: "gemini", modelName: "a", apiKey: "k2" } as any,
        { provider: "groq", modelName: "b", apiKey: "k3" } as any,
      ],
    );
    expect(
      merged.map((m) => `${m.provider}:${m.modelName}:${m.apiKey}`),
    ).toEqual(["gemini:a:k", "groq:b:k3"]);
  });
});
