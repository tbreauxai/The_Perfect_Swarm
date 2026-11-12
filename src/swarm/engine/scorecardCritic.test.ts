import { describe, expect, it, vi } from "vitest";
import { SwarmContext } from "../context.ts";
import {
  runScorecardCritic,
  SCORECARD_CRITIC_MAX_TOKENS,
} from "./scorecardCritic.ts";

describe("scorecard critic provider configuration", () => {
  it("uses 2000 tokens and disables OpenRouter reasoning", async () => {
    const configs: any[] = [];
    const critic = {
      role: "Test Critic",
      provider: "openrouter",
      modelName: "test-model",
      setSystemInstruction: vi.fn(),
      async run(_prompt: string, _context: SwarmContext, config: any) {
        configs.push(config);
        return JSON.stringify({
          seat: "critic",
          picks: [],
          edge: 0,
          key_risk: "none",
          confidence: 0.5,
          status: "ok",
          row_risks: [],
        });
      },
    };

    await runScorecardCritic({
      critic: critic as any,
      blackboard: {
        brief: "test",
        scorecards: [],
        degraded: [],
        citedRows: [],
        unknownRows: [],
      },
      context: new SwarmContext(),
      bypassCache: false,
    });

    expect(SCORECARD_CRITIC_MAX_TOKENS).toBe(2000);
    expect(configs[0]).toMatchObject({
      maxTokens: 2000,
      reasoning: { enabled: false, exclude: true },
    });
  });
});
