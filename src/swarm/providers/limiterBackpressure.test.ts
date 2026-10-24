import { describe, it, expect } from "vitest";
import {
  ProviderLimiter,
  LimiterSkipError,
  classifyProviderError,
  DEFAULT_STRICT_BUDGET_WAIT_MS,
  INTERACTIVE_MAX_BUDGET_WAIT_MS
} from "./limiter.ts";
import { executeOpenAiCompatibleChat } from "./baseOpenAi.ts";

function makeClock(start: number) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe("Module 2: Resilient Token Backpressure & Circuit Breaker Isolation", () => {
  it("classifyProviderError splits rate_limit (429) from server_error (5xx)", () => {
    expect(classifyProviderError("groq", "[RATE_LIMIT_429] Rate limit exceeded")).toBe("rate_limit");
    expect(classifyProviderError("gemini", "RESOURCE_EXHAUSTED: quota exceeded")).toBe("rate_limit");
    expect(classifyProviderError("openrouter", "[SERVER_ERROR_503] service unavailable")).toBe("server_error");
    expect(classifyProviderError("groq", "[SERVER_ERROR_500] internal error")).toBe("server_error");
    expect(classifyProviderError("openrouter", "free-models-per-day")).toBe("daily_quota");
    expect(classifyProviderError("groq", "404 model not found")).toBe("model_dead");
    expect(classifyProviderError("groq", "400 invalid request")).toBe("other");
  });

  it("configurable maxBudgetWaitMs: queueing up to 65,000ms succeeds instead of throwing LimiterSkipError", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 23, 12, 0, 0));
    // Limiter with strict backpressure (65,000ms maxBudgetWaitMs)
    const limiter = new ProviderLimiter(
      {
        groq: { concurrency: 1, minSpacingMs: 0, tokensPerMinute: 7000, maxInputTokens: 1500, maxBudgetWaitMs: 65_000 }
      },
      clock.now,
      clock.sleep
    );

    // Call 1: consumes 5,000 tokens
    await limiter.run(
      { provider: "groq", model: "test-model", estTokens: 5000 },
      async () => "call-1-ok"
    );

    // Call 2: requests 3,000 tokens (5,000 + 3,000 = 8,000 > 7,000 TPM limit).
    // Requires ~60,000ms wait until sliding window clears.
    // Under strict backpressure (65,000ms wait cap), this MUST queue, sleep, and succeed.
    const res = await limiter.run(
      { provider: "groq", model: "test-model", estTokens: 3000 },
      async () => "call-2-ok"
    );

    expect(res).toBe("call-2-ok");
    expect(clock.sleeps.some(ms => ms >= 50_000 && ms <= 65_000)).toBe(true);
  });

  it("AC-02: Zero Premature Failover on Groq - ingesting 15,000 tokens on 7,000 TPM queues and completes", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 23, 12, 0, 0));
    const limiter = new ProviderLimiter(
      {
        groq: { concurrency: 1, minSpacingMs: 0, tokensPerMinute: 7000, maxInputTokens: 1500, maxBudgetWaitMs: 65_000 }
      },
      clock.now,
      clock.sleep
    );

    const completedCalls: number[] = [];
    const runChunk = async (chunkIndex: number, tokens: number) => {
      return limiter.run(
        { provider: "groq", model: "test-model", estTokens: tokens, maxBudgetWaitMs: DEFAULT_STRICT_BUDGET_WAIT_MS },
        async () => {
          completedCalls.push(chunkIndex);
          return `chunk-${chunkIndex}-done`;
        }
      );
    };

    // Dispatch 10 chunks of 1,500 tokens = 15,000 total tokens against Groq's 7,000 TPM
    for (let i = 0; i < 10; i++) {
      const res = await runChunk(i, 1500);
      expect(res).toBe(`chunk-${i}-done`);
    }

    expect(completedCalls.length).toBe(10);
    // Verified: all 10 chunks completed without any premature failover or LimiterSkipError
  });

  it("AC-03: 429 Retry-After Handling - pauses for Retry-After duration + jitter, successfully retries, and avoids opening circuit", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const retryAfterSeconds = 3;

    // Mock fetch that returns 429 with Retry-After: 3 on attempt 1, and 200 OK on attempt 2
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(retryAfterSeconds)
          }
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "recovered-after-429" } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const options = {
        modelName: "openai/gpt-oss-120b",
        prompt: "test prompt",
        apiKey: "gsk-mock-key"
      };

      const start = Date.now();
      const output = await executeOpenAiCompatibleChat(options, {
        providerName: "groq",
        providerLabel: "Groq",
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        apiKey: "gsk-mock-key",
        modelName: options.modelName,
        messages: [{ role: "user", content: options.prompt }],
        maxTokens: 500,
        isJson: false,
        timeoutMs: 10000
      });

      expect(output).toBe("recovered-after-429");
      expect(callCount).toBe(2);
      // Ensure at least retryAfterSeconds * 1000ms was paused
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(3000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("transient 429 errors with successful retry do not trip circuit breaker", async () => {
    const limiter = new ProviderLimiter({
      groq: { concurrency: 1, minSpacingMs: 0, tokensPerMinute: 7000 }
    });

    // Simulated 3 transient 429s where caller retried and succeeded (recordSuccess)
    for (let i = 0; i < 3; i++) {
      limiter.recordFailure("groq", "test-model", "[RATE_LIMIT_429] 429 too many requests", false);
      limiter.recordSuccess("groq");
    }

    // Circuit breaker MUST remain closed and available
    expect(limiter.isAvailable("groq")).toBe(true);
  });
});
