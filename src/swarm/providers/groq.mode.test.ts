import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GroqAdapter,
  computeGroqMaxTokens,
  computeGroqChatMaxTokens,
  GROQ_CHAT_PROMPT_CHARS,
} from "./groq.ts";
import { LimiterSkipError, globalProviderLimiter } from "./limiter.ts";
import { ProviderRegistry } from "./registry.ts";
import { Agent } from "../agent.ts";
import { SwarmContext } from "../context.ts";

describe("Groq mode budget (PS2)", () => {
  const originalFetch = globalThis.fetch;
  let bodies: any[] = [];

  beforeEach(() => {
    globalProviderLimiter.reset();
    bodies = [];
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"status":"ok"}' } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
        };
      }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalProviderLimiter.reset();
  });

  it("chat: an 18k-char prompt is capped at 18,000 chars and gets max_tokens <= 2000", async () => {
    await new GroqAdapter().call({
      modelName: "openai/gpt-oss-120b",
      prompt: "x".repeat(25_000),
      apiKey: "gsk-test",
      role: "Data Analyst",
      config: { groqMode: "chat" },
    });
    const userMsg = bodies[0].messages.find((m: any) => m.role === "user");
    expect(userMsg.content.length).toBe(GROQ_CHAT_PROMPT_CHARS);
    expect(bodies[0].max_tokens).toBeLessThanOrEqual(2000);
    expect(bodies[0].max_tokens).toBe(computeGroqChatMaxTokens(18_000)); // min(2000, 7000 - 4500) = 2000
    expect(computeGroqChatMaxTokens(24_000)).toBe(1000); // 7000 - 6000
  });

  it("chat: a prompt that leaves < 800 max_tokens skips Groq without calling the API", async () => {
    await expect(
      new GroqAdapter().call({
        modelName: "openai/gpt-oss-120b",
        prompt: "x".repeat(18_000),
        systemInstruction: "S".repeat(8_000), // 26,000 chars -> 6,500 tokens -> 500 < 800
        apiKey: "gsk-test",
        role: "Data Analyst",
        config: { groqMode: "chat" },
      }),
    ).rejects.toBeInstanceOf(LimiterSkipError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("chat: Agent.run moves on to the next fallback when Groq is skipped for budget", async () => {
    ProviderRegistry.register({
      providerName: "groq-budget-backup-mock",
      async call() {
        return JSON.stringify({ source: "backup" });
      },
    } as any);
    const agent = new Agent(
      "Data Analyst",
      "openai/gpt-oss-120b",
      "groq" as any,
      "gsk-test",
      undefined,
      [
        {
          provider: "groq-budget-backup-mock" as any,
          apiKey: "k",
          modelName: "backup-model",
        },
      ],
    );
    agent.setSystemInstruction("S".repeat(8_000));
    const result = await agent.run("x".repeat(18_000), new SwarmContext(), {
      responseMimeType: "application/json",
      groqMode: "chat",
      bypassCache: true,
    });
    expect(result.source).toBe("backup");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("morning (and no mode): unchanged legacy 6k cap and computeGroqMaxTokens values", async () => {
    const managerOpts = {
      modelName: "openai/gpt-oss-120b",
      prompt: "x".repeat(30_000),
      apiKey: "gsk-test",
      role: "Manager Node",
      config: { groqMode: "morning", maxTokens: 5000 },
    };
    await new GroqAdapter().call(managerOpts);
    await new GroqAdapter().call({
      ...managerOpts,
      config: { maxTokens: 5000 },
    }); // no mode = legacy
    for (const body of bodies) {
      const userMsg = body.messages.find((m: any) => m.role === "user");
      expect(userMsg.content.length).toBe(6000);
      expect(body.max_tokens).toBe(4500); // 6000 - ceil(6000/4)
      expect(body.max_tokens).toBe(
        computeGroqMaxTokens(managerOpts as any, 1500),
      );
    }

    await new GroqAdapter().call({
      modelName: "openai/gpt-oss-120b",
      prompt: "Analyze market steam",
      apiKey: "gsk-test",
      role: "Market Proposer",
      config: { groqMode: "morning" },
    });
    expect(bodies[2].max_tokens).toBe(1024);
  });
});
