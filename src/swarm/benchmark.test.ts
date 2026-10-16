import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SwarmBenchmarker,
  buildBenchmarkTargets,
  initBenchmarker,
  isStartupBenchmarkEnabled,
  isRateLimitError,
  globalBenchmarker,
  STARTUP_BENCHMARK_ENV,
} from "./benchmark.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { globalProviderLimiter } from "./providers/limiter.ts";

const KEYS = { GROQ_API_KEY: "gsk-test", OPENROUTER_API_KEY: "sk-or-v1-test" };
const calls: string[] = [];

describe("startup benchmark: gated, no gemma, never retries a 429", () => {
  beforeEach(() => {
    calls.length = 0;
    globalProviderLimiter.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`unexpected network call in test: ${url}`);
      }),
    );
    ProviderRegistry.list(); // registry init first, then the doubles replace the real adapters
    for (const providerName of ["groq", "openrouter"]) {
      ProviderRegistry.register({
        providerName,
        async call(o: any) {
          calls.push(`${providerName}/${o.modelName}`);
          throw new Error(
            `[RATE_LIMIT_429] ${providerName} rate limit: free-models-per-min`,
          );
        },
      } as any);
    }
  });

  afterEach(() => {
    globalBenchmarker.stopSchedule();
    vi.unstubAllGlobals();
    globalProviderLimiter.reset();
  });

  it(`is off by default; only ${STARTUP_BENCHMARK_ENV}=1/true/yes/on turns it on`, () => {
    expect(isStartupBenchmarkEnabled({})).toBe(false);
    expect(isStartupBenchmarkEnabled({ ...KEYS })).toBe(false);
    expect(isStartupBenchmarkEnabled({ [STARTUP_BENCHMARK_ENV]: "0" })).toBe(
      false,
    );
    expect(
      isStartupBenchmarkEnabled({ [STARTUP_BENCHMARK_ENV]: "false" }),
    ).toBe(false);
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(isStartupBenchmarkEnabled({ [STARTUP_BENCHMARK_ENV]: v })).toBe(
        true,
      );
    }
  });

  it("initBenchmarker with provider keys but no flag makes zero provider calls", async () => {
    expect(initBenchmarker({ ...KEYS })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it("targets: no gemma-4-31b; one OpenRouter model (nemotron-3-super :free)", () => {
    const ids = buildBenchmarkTargets(KEYS).map(
      (t) => `${t.provider}/${t.modelName}`,
    );
    expect(ids).toEqual([
      "groq/openai/gpt-oss-120b",
      "groq/openai/gpt-oss-20b",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    expect(ids.join(" ")).not.toMatch(/gemma/i);
  });

  it("a 429 is never retried and the rest of that provider is skipped: exactly one call per provider", async () => {
    const b = new SwarmBenchmarker(buildBenchmarkTargets(KEYS));
    b.betweenTestsMs = 0;
    b.betweenModelsMs = 0;
    const results = await b.run();
    expect(calls).toEqual([
      "groq/openai/gpt-oss-120b",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    expect(results.map((r) => r.modelName)).toEqual([
      "openai/gpt-oss-120b",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    expect(results.every((r) => !r.passRouting && !r.passReasoning)).toBe(true);
  });

  it("isRateLimitError recognizes the adapters' 429 messages", () => {
    expect(
      isRateLimitError(
        new Error(
          "[RATE_LIMIT_429] OpenRouter rate limit / credit exhaustion: x",
        ),
      ),
    ).toBe(true);
    expect(
      isRateLimitError(new Error("Groq API Error (429): too many requests")),
    ).toBe(true);
    expect(
      isRateLimitError(new Error("OpenRouter API Error (404): no endpoints")),
    ).toBe(false);
  });
});
