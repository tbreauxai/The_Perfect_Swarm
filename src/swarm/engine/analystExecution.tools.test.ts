import { describe, expect, it, vi } from "vitest";
import { SwarmContext } from "../context.ts";
import { ToolRegistry } from "../tools/index.ts";
import { createAnalystExecutor } from "./analystExecution.ts";

const gameData = "event_id|home|away\n123|Home team|Away team";

describe("provider-specific tool handling", () => {
  it.each([
    ["groq", true],
    ["mistral", true],
    ["gemini", true],
  ])("%s normal analyst preserves game data and applies its tool policy", async (provider, usesTools) => {
    let systemInstruction = "";
    let prompt = "";
    let runConfig: any;
    const analyst = {
      id: `${provider}-seat`,
      role: "Test Analyst",
      provider,
      modelName: "test-model",
      setSystemInstruction: vi.fn((value: string) => { systemInstruction = value; }),
      async run(value: string, _context: unknown, config: any) {
        prompt = value;
        runConfig = config;
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
    if (provider === "groq") {
      expect(systemInstruction.includes(toolRegistry.renderPromptSchema())).toBe(false);
      expect(runConfig.tools).toHaveLength(1);
      expect(runConfig.tools[0].function.name).toBe("test_tool");
      expect(runConfig.toolChoice).toBe("auto");
    } else {
      expect(systemInstruction.includes(toolRegistry.renderPromptSchema())).toBe(usesTools);
    }
    expect(context.events.some((event) => event.action === "Executed Tool: test_tool")).toBe(true);
    expect(context.events.find((event) => event.action === "Executed Tool: test_tool")?.output).toEqual({ value: 7 });
  });

  it("does not send or execute Groq tools when ad-hoc tools are disabled", async () => {
    let runConfig: any;
    const analyst = {
      id: "groq-seat",
      role: "Test Analyst",
      provider: "groq",
      modelName: "test-model",
      setSystemInstruction: vi.fn(),
      async run(_prompt: string, _context: unknown, config: any) {
        runConfig = config;
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
      disableAdHocTools: true,
    });

    await executeAnalyst(analyst as any, gameData, 0);

    expect(runConfig.tools).toBeUndefined();
    expect(context.events.some((event) => event.action === "Executed Tool: test_tool")).toBe(false);
  });
});
