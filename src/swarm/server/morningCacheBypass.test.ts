import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runMorningSlate } from "../morning/index.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { globalSemanticCache, globalPayloadCache } from "../cache.ts";
import {
  globalTokenBudgetManager,
  globalSpecialistProfiler,
  globalNodeCapacityManager,
} from "../loadBalancer.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";

/**
 * Root cause 2026-10-16 (identical ~4s morning judgments): runMorningSlate called the swarm without bypassCache, so the
 * lexical semantic baseline cache (threshold 0.80, task text only) returned game 1's verdict for game 2 with no LLM call.
 * Two NBA games with near-identical prompts: each must get its own provider calls and its own verdict.
 */
const GAMES = [
  {
    id: "nba-g1",
    home: "Boston Celtics",
    away: "New York Knicks",
    spread: -4.5,
    total: 221.5,
    winProbHome: 0.64,
  },
  {
    id: "nba-g2",
    home: "Boston Bruins Hoops",
    away: "New York Nets",
    spread: -2.5,
    total: 219.5,
    winProbHome: 0.41,
  },
];

function espnFetch(): typeof fetch {
  return vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes("/sports/basketball/nba/")) {
      return new Response(
        JSON.stringify({
          events: GAMES.map((g) => ({
            id: g.id,
            date: "2026-10-16T23:30:00Z",
            competitions: [
              {
                venue: { fullName: "Garden", indoor: true },
                competitors: [
                  { homeAway: "home", team: { displayName: g.home } },
                  { homeAway: "away", team: { displayName: g.away } },
                ],
                odds: [
                  {
                    details: `BOS ${g.spread}`,
                    spread: g.spread,
                    overUnder: g.total,
                  },
                ],
              },
            ],
          })),
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  }) as any;
}

const calls: { analyst: string[]; manager: string[] } = {
  analyst: [],
  manager: [],
};

function gameFor(text: string) {
  return GAMES.find((g) => text.includes(`${g.away} @ ${g.home}`));
}

describe("morning run: every game gets its own model call (no cross-game cache hit)", () => {
  beforeEach(() => {
    calls.analyst = [];
    calls.manager = [];
    globalSemanticCache.clear?.();
    (globalPayloadCache as any).clear?.();
    globalTokenBudgetManager.reset();
    globalSpecialistProfiler.reset();
    globalNodeCapacityManager.reset();
    globalProviderLimiter.reset();
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    // No network: any real provider HTTP call fails the test loudly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`unexpected network call in test: ${url}`);
      }),
    );
    // Test doubles registered under the real provider names, after the registry's own init (module state is per test file).
    ProviderRegistry.list();
    // One double for both morning providers: the judge is recognized by its system prompt, so this test doesn't
    // depend on which provider hosts the judge seat.
    for (const providerName of ["groq", "mistral"]) {
      ProviderRegistry.register({
        providerName,
        async call(o: any) {
          const isJudge = String(o.systemInstruction || "").includes(
            "Morning Swarm Judge",
          );
          const g = gameFor(o.prompt);
          if (!isJudge) {
            calls.analyst.push(o.prompt);
            return JSON.stringify({
              insights: [`edge read for ${g?.home}`],
              anomalies: [],
              summary: `lean ${g?.home}`,
            });
          }
          calls.manager.push(o.prompt);
          return JSON.stringify({
            likelyWinner: g!.winProbHome >= 0.5 ? g!.home : g!.away,
            winProbHome: g!.winProbHome,
            winProbAway: Math.round((1 - g!.winProbHome) * 100) / 100,
            fairSpread: g!.spread,
            fairTotal: g!.total,
            totalLean: "none",
            arguments: [],
            invalidationConditions: [],
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

  it("two NBA games in one run: two manager calls, analysts called for both games, two different verdicts", async () => {
    const result = await runMorningSlate({
      dateInput: "2026-10-16",
      env: { GROQ_API_KEY: "gsk-test", MISTRAL_API_KEY: "mistral-test" },
      fetchFn: espnFetch(),
    });

    expect(result.ok).toBe(true);
    expect(result.judged).toBe(2);
    // One fresh judge (manager) call per game: a semantic-cache hit would skip the second one.
    expect(calls.manager).toHaveLength(2);
    expect(calls.manager.map((p) => gameFor(p)?.id).sort()).toEqual([
      "nba-g1",
      "nba-g2",
    ]);
    expect(new Set(calls.analyst.map((p) => gameFor(p)?.id))).toEqual(
      new Set(["nba-g1", "nba-g2"]),
    );
  });

  it("the morning call asks the engine to bypass every cache", async () => {
    const seen: any[] = [];
    await runMorningSlate({
      dateInput: "2026-10-16",
      env: { GROQ_API_KEY: "gsk-test" },
      fetchFn: espnFetch(),
      executeWorkflowFn: (async (params: any) => {
        seen.push(params);
        return {
          workflowId: `wf-${seen.length}`,
          finalAnalysis: { winProbHome: 0.5, fairSpread: 0, likelyWinner: "" },
        };
      }) as any,
    });
    expect(seen).toHaveLength(2);
    for (const p of seen) expect(p.bypassCache).toBe(true);
  });
});
