import { describe, it, expect } from "vitest";
import {
  ProviderLimiter,
  LimiterSkipError,
  nextUtcMidnight,
  BREAKER_OPEN_MS,
  DEAD_MODEL_MS,
  RETRY_503_BACKOFF_MS,
} from "./limiter.ts";

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

describe("ProviderLimiter (PS2)", () => {
  it("groq: defers a call that fits within ~10s and skips one that would wait longer", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 15, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);
    const ok = async () => "ok";

    await limiter.run(
      { provider: "groq", model: "openai/gpt-oss-120b", estTokens: 5000 },
      ok,
    );

    // 5000 + 3000 > 7000 and the window frees in ~60s: skip, don't wait.
    await expect(
      limiter.run(
        { provider: "groq", model: "openai/gpt-oss-120b", estTokens: 3000 },
        ok,
      ),
    ).rejects.toBeInstanceOf(LimiterSkipError);

    // 55s later the first entry frees in ~5s, so the call waits (deferred) and then runs.
    clock.advance(55_000);
    const out = await limiter.run(
      { provider: "groq", model: "openai/gpt-oss-120b", estTokens: 3000 },
      ok,
    );
    expect(out).toBe("ok");
    expect(clock.sleeps.some((ms) => ms > 0 && ms <= 10_000)).toBe(true);
  });

  it("groq: runs one call at a time (concurrency 1)", async () => {
    const limiter = new ProviderLimiter();
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return "done";
    };
    await Promise.all([
      limiter.run({ provider: "groq", model: "m", estTokens: 10 }, job),
      limiter.run({ provider: "groq", model: "m", estTokens: 10 }, job),
    ]);
    expect(maxActive).toBe(1);
  });

  it("openrouter: free-models-per-day 429 opens the circuit until 00:00 UTC", async () => {
    const start = Date.UTC(2026, 9, 16, 18, 30, 0);
    const clock = makeClock(start);
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);

    await expect(
      limiter.run(
        { provider: "openrouter", model: "x:free", estTokens: 10 },
        async () => {
          throw new Error(
            "[RATE_LIMIT_429] OpenRouter rate limit / credit exhaustion: Rate limit exceeded: free-models-per-day",
          );
        },
      ),
    ).rejects.toThrow(/free-models-per-day/);

    expect(limiter.isAvailable("openrouter")).toBe(false);
    await expect(
      limiter.run(
        { provider: "openrouter", model: "other:free", estTokens: 10 },
        async () => "never",
      ),
    ).rejects.toBeInstanceOf(LimiterSkipError);

    const midnight = nextUtcMidnight(start);
    expect(midnight).toBe(Date.UTC(2026, 9, 17, 0, 0, 0));
    clock.advance(midnight - start - 1);
    expect(limiter.isAvailable("openrouter")).toBe(false);
    clock.advance(2);
    expect(limiter.isAvailable("openrouter")).toBe(true);
  });

  it("404 model-not-found marks only that model dead for 24h", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);

    await expect(
      limiter.run(
        { provider: "gemini", model: "gone-model", estTokens: 10 },
        async () => {
          throw new Error("Gemini API Error (404): NOT_FOUND model not found");
        },
      ),
    ).rejects.toThrow(/404/);

    expect(limiter.isAvailable("gemini", "gone-model")).toBe(false);
    expect(limiter.isAvailable("gemini", "live-model")).toBe(true);
    expect(limiter.isAvailable("gemini")).toBe(true);

    clock.advance(DEAD_MODEL_MS + 1);
    expect(limiter.isAvailable("gemini", "gone-model")).toBe(true);
  });

  it("3 consecutive 429/5xx open the provider for 5 minutes; a success resets the count", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);
    const fail429 = async () => {
      throw new Error("[RATE_LIMIT_429] Mistral API rate limit exceeded");
    };

    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    await limiter.run(
      { provider: "mistral", model: "m", estTokens: 1 },
      async () => "ok",
    ); // resets the count
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    expect(limiter.isAvailable("mistral")).toBe(true);
    await expect(
      limiter.run({ provider: "mistral", model: "m", estTokens: 1 }, fail429),
    ).rejects.toThrow();
    expect(limiter.isAvailable("mistral")).toBe(false);

    clock.advance(BREAKER_OPEN_MS + 1);
    expect(limiter.isAvailable("mistral")).toBe(true);
  });

  it("retries a 503 exactly once after a backoff, and never retries a 429", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
    const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);

    let calls503 = 0;
    const out = await limiter.run(
      { provider: "gemini", model: "g", estTokens: 1 },
      async () => {
        calls503++;
        if (calls503 === 1)
          throw new Error("[SERVER_ERROR_503] service unavailable");
        return "recovered";
      },
    );
    expect(out).toBe("recovered");
    expect(calls503).toBe(2);
    expect(clock.sleeps).toContain(RETRY_503_BACKOFF_MS);

    let calls429 = 0;
    await expect(
      limiter.run(
        { provider: "gemini", model: "g", estTokens: 1 },
        async () => {
          calls429++;
          throw new Error("[RATE_LIMIT_429] quota");
        },
      ),
    ).rejects.toThrow();
    expect(calls429).toBe(1);
  });

  it("passes unmanaged providers (mocks/simulated) straight through", async () => {
    const limiter = new ProviderLimiter();
    for (let i = 0; i < 5; i++) {
      await expect(
        limiter.run(
          { provider: "custom-mock", model: "m", estTokens: 1 },
          async () => {
            throw new Error("[RATE_LIMIT_429] x");
          },
        ),
      ).rejects.toThrow();
    }
    expect(limiter.isAvailable("custom-mock")).toBe(true);
  });
});
