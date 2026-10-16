import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GroqAdapter, computeGroqScorecardMaxTokens } from "./groq.ts";
import { globalProviderLimiter, LimiterSkipError } from "./limiter.ts";

describe("Groq scorecard cap (R2-S1): min(cap, 7000 - ceil(promptChars/4)), skip below 800", () => {
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
            usage: { total_tokens: 10 },
          }),
        };
      }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // promptChars = system instruction + prompt (the prompt stays under the 18,000-char chat cap here).
  const call = (config: any, promptChars = 4_000, systemChars = 0) =>
    new GroqAdapter().call({
      modelName: "openai/gpt-oss-120b",
      prompt: "x".repeat(promptChars),
      systemInstruction: systemChars ? "s".repeat(systemChars) : undefined,
      apiKey: "gsk-test",
      role: "Line Analyst",
      config,
    });

  it("formula: min(cap, 7000 - ceil(chars/4))", () => {
    expect(computeGroqScorecardMaxTokens(800, 4_000)).toBe(800); // remainder 6000
    expect(computeGroqScorecardMaxTokens(1500, 24_000)).toBe(1000); // remainder 1000
    expect(computeGroqScorecardMaxTokens(800, 24_801)).toBe(799); // ceil(24801/4) = 6201
  });

  it("chat, default cap 800 with room: max_tokens is 800", async () => {
    await call({ groqMode: "chat", maxTokens: 800, maxTokensCap: 800 });
    expect(bodies[0].max_tokens).toBe(800);
  });

  it("chat, override above the 2000 chat ceiling is honored while the budget allows (min(3000, 6000))", async () => {
    await call({ groqMode: "chat", maxTokensCap: 3000 });
    expect(bodies[0].max_tokens).toBe(3000);
  });

  it("chat, the remainder wins when it is below the cap (cap 1500, 24,000 chars => 1000)", async () => {
    await call({ groqMode: "chat", maxTokensCap: 1500 }, 18_000, 6_000);
    expect(bodies[0].max_tokens).toBe(1000);
  });

  it("chat, remainder under 800 (25,000 chars => 750): Groq is skipped with LimiterSkipError, no request sent", async () => {
    await expect(
      call({ groqMode: "chat", maxTokensCap: 800 }, 18_000, 7_000),
    ).rejects.toBeInstanceOf(LimiterSkipError);
    expect(bodies).toHaveLength(0);
  });

  it("chat without a cap is unchanged (budget formula, up to 2000)", async () => {
    await call({ groqMode: "chat", maxTokens: 1500 });
    expect(bodies[0].max_tokens).toBe(2000);
  });
});
