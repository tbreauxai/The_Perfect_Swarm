import { describe, it, expect, vi, afterEach } from "vitest";
import { GitHubAdapter, GITHUB_MODELS_RETIRED_MESSAGE } from "./github.ts";
import { ProviderRegistry } from "./registry.ts";
import { Agent, DEFAULT_PROVIDER_MODELS } from "../agent.ts";
import { SwarmContext } from "../context.ts";
import { ModelRouter } from "../router.ts";
import {
  fetchProviderModels,
  warnUnknownConfiguredModels,
} from "../server/modelsProvider.ts";
import { resolveSwarmAgents } from "../engine/agentResolution.ts";

describe("GitHub Models retired (2026-07-30)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("GitHubAdapter fails fast with the retired error and never calls the network", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    await expect(
      new GitHubAdapter().call({
        modelName: "gpt-4o-mini",
        prompt: "hello",
        apiKey: "ghp_test_token",
        role: "Analyst",
      } as any),
    ).rejects.toThrow(/retired/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(GITHUB_MODELS_RETIRED_MESSAGE).toMatch(/does not exist/);
  });

  it("a stale github seat fails over to its fallback immediately (fatal, no retry)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    ProviderRegistry.register({
      providerName: "gh-retired-backup-mock",
      async call() {
        return JSON.stringify({ source: "backup" });
      },
    } as any);
    const agent = new Agent(
      "Analyst",
      "gpt-4o-mini",
      "github" as any,
      "ghp_test_token",
      undefined,
      [
        {
          provider: "gh-retired-backup-mock" as any,
          apiKey: "k",
          modelName: "backup-model",
        },
      ],
    );
    const started = Date.now();
    const result = await agent.run("prompt", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("backup");
    expect(Date.now() - started).toBeLessThan(1500); // no 2s retry backoff
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no github default model and no github router recommendation", () => {
    expect(DEFAULT_PROVIDER_MODELS.github).toBeUndefined();
    expect(ModelRouter.getRecommendedModel("github", "instant")).not.toBe(
      "gpt-4o-mini",
    );
  });

  it("/api/swarm/models never keys, lists or probes github", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    expect(
      await fetchProviderModels("github", "ghp_test_token", {
        GITHUB_TOKEN: "ghp_test_token",
      }),
    ).toEqual([]);
    expect(
      await warnUnknownConfiguredModels(
        { github: ["gpt-4o-mini"] },
        { GITHUB_TOKEN: "ghp_test_token" },
      ),
    ).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("github never joins the analyst or manager fallbacks, even with GITHUB_TOKEN set and a github seat", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_key");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const resolved = resolveSwarmAgents(
      {
        agents: [
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
          {
            id: "g1",
            role: "Groq Seat",
            provider: "groq",
            model: "openai/gpt-oss-20b",
          },
          {
            id: "gh",
            role: "Stale GitHub Seat",
            provider: "github",
            model: "gpt-4o-mini",
          },
        ],
      } as any,
      undefined,
    );
    const providers = [
      ...resolved.managerAgent.getFallbacks(),
      ...resolved.analysts.flatMap((a: any) => a.getFallbacks()),
    ].map((f) => String(f.provider));
    expect(providers).toContain("groq");
    expect(providers).not.toContain("github");
  });
});
