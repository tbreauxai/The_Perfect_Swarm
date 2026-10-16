import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Agent } from "./agent.ts";
import { SwarmContext } from "./context.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { GeminiAdapter } from "./providers/gemini.ts";
import { MistralAdapter } from "./providers/mistral.ts";
import { GroqAdapter } from "./providers/groq.ts";
import { globalProviderLimiter } from "./providers/limiter.ts";

const calls: string[] = [];

function registerMock(name: string, ok: boolean) {
  ProviderRegistry.register({
    providerName: name,
    async call() {
      calls.push(name);
      if (!ok) throw new Error("Mock API Error (400): primary down");
      return JSON.stringify({ source: name });
    },
  } as any);
}

// Load balancer stub that scores 'order-b-mock' highest, so a re-sort would put it first.
const lbFavoringB: any = {
  calculateScore: (p: string) => (p === "order-b-mock" ? 100 : 0),
  executeWithTelemetry: (_p: any, fn: () => Promise<any>) => fn(),
};

describe("Agent fallback order (PS3 preserveFallbackOrder)", () => {
  beforeEach(() => {
    calls.length = 0;
    globalProviderLimiter.reset();
    registerMock("order-dead-mock", false);
    registerMock("order-a-mock", true);
    registerMock("order-b-mock", true);
  });

  afterEach(() => {
    ProviderRegistry.register(new GeminiAdapter());
    ProviderRegistry.register(new MistralAdapter());
    ProviderRegistry.register(new GroqAdapter());
    globalProviderLimiter.reset();
  });

  const fallbacks = [
    { provider: "order-a-mock" as any, apiKey: "k", modelName: "a" },
    { provider: "order-b-mock" as any, apiKey: "k", modelName: "b" },
  ];

  it("keeps the configured order when preserveFallbackOrder is true (no load-balancer re-sort)", async () => {
    const agent = new Agent(
      "Manager Node",
      "m",
      "order-dead-mock" as any,
      "k",
      undefined,
      fallbacks,
      lbFavoringB,
    );
    agent.preserveFallbackOrder = true;
    const result = await agent.run("prompt", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("order-a-mock");
    expect(calls).toEqual(["order-dead-mock", "order-a-mock"]);
  });

  it("still re-sorts by load-balancer score when the flag is off (analyst default)", async () => {
    const agent = new Agent(
      "Analyst",
      "m",
      "order-dead-mock" as any,
      "k",
      undefined,
      fallbacks,
      lbFavoringB,
    );
    const result = await agent.run("prompt 2", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("order-b-mock");
  });

  it("in configured order, skips an open circuit and a dead model without calling them", async () => {
    registerMock("gemini", true);
    registerMock("mistral", true);
    registerMock("groq", true);
    for (let i = 0; i < 3; i++)
      globalProviderLimiter.recordFailure(
        "gemini",
        "gemini-2.5-flash",
        "[RATE_LIMIT_429] x",
      );
    globalProviderLimiter.recordFailure(
      "mistral",
      "dead-model",
      "Mistral API Error (404): model not found",
    );

    // Same shape as MANAGER_CHAIN: gemini (circuit open, both models), mistral (dead model), then groq.
    const agent = new Agent(
      "Manager Node",
      "m",
      "order-dead-mock" as any,
      "k",
      undefined,
      [
        {
          provider: "gemini" as any,
          apiKey: "k",
          modelName: "gemini-2.5-flash",
        },
        {
          provider: "gemini" as any,
          apiKey: "k",
          modelName: "gemini-2.5-flash-lite",
        },
        { provider: "mistral" as any, apiKey: "k", modelName: "dead-model" },
        {
          provider: "groq" as any,
          apiKey: "k",
          modelName: "openai/gpt-oss-120b",
        },
      ],
      lbFavoringB,
    );
    agent.preserveFallbackOrder = true;
    const result = await agent.run("prompt 3", new SwarmContext(), {
      responseMimeType: "application/json",
      bypassCache: true,
    });
    expect(result.source).toBe("groq");
    expect(calls).toEqual(["order-dead-mock", "groq"]);
  });
});
