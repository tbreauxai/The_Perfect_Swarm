import { describe, expect, it, vi } from "vitest";
import { SwarmContext } from "../context.ts";
import { ToolRegistry } from "../tools/index.ts";
import { createAnalystExecutor } from "./analystExecution.ts";

const gameData = "event_id|home|away\n123|Home team|Away team";

describe("provider-specific ad-hoc tool handling", () => {
  it.each([
    ["groq", false],
    ["mistral", true],
    ["gemini", true],
  ])("%s normal analyst preserves game data and applies its tool policy", async (provider, usesTools) => {
    let systemInstruction = "";
    let prompt = "";
    const analyst = {
      id: `${provider}-seat`,
      role: "Test Analyst",
      provider,
      modelName: "test-model",
      setSystemInstruction: vi.fn((value: string) => { systemInstruction = value; }),
      async run(value: string) {
        prompt = value;
        return '[TOOL_CALL:{"tool":"test_tool","parameters":{"value":7}}]';
      },
    };
    const toolRegistry = new ToolRegistry([{
      name: "test_tool",
      description: "Test tool",
      parameters: { value: { type: "number", description: "Value" } },
      execute: async ({ value }: { value: number }) => ({ value }),
    }]);
    const context = new SwarmContext();
    const executeAnalyst = createAnalystExecutor({
      task: "Analyze this game",
      chunks: [gameData],
      profile: {},
      historicalContext: "",
      targetAppId: "test-app",
      context,
      toolRegistry,
      analystClusterMap: new Map(),
      bypassCache: true,
    });

    await executeAnalyst(analyst as any, gameData, 0);

    expect(prompt).toContain(`Data Chunk [1/1]:\n${gameData}`);
    expect(systemInstruction.includes(toolRegistry.renderPromptSchema())).toBe(usesTools);
    expect(context.events.some((event) => event.action === "Executed Tool: test_tool")).toBe(usesTools);
  });
});
