import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqAdapter } from "./groq.ts";
import { MistralAdapter } from "./mistral.ts";
import { OpenRouterAdapter } from "./openrouter.ts";

describe("provider reasoning configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds reasoning to OpenRouter requests only when configured", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
          { status: 200 },
        );
      }),
    );

    const adapter = new OpenRouterAdapter();
    const reasoning = { enabled: false, exclude: true };
    await adapter.call({
      modelName: "nvidia/nemotron-3.5-lightning:free",
      prompt: "test",
      apiKey: "sk-or-v1-test",
      config: { reasoning },
    });
    await adapter.call({
      modelName: "nvidia/nemotron-3.5-lightning:free",
      prompt: "test",
      apiKey: "sk-or-v1-test",
    });

    expect(bodies[0].reasoning).toEqual(reasoning);
    expect(bodies[1]).not.toHaveProperty("reasoning");
  });

  it("does not add the OpenRouter reasoning field to Groq or Mistral requests", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
          { status: 200 },
        );
      }),
    );

    const options = {
      modelName: "test-model",
      prompt: "test",
      apiKey: "test-key",
      config: { reasoning: { enabled: false, exclude: true } },
    };
    await new GroqAdapter().call(options);
    await new MistralAdapter().call(options);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("reasoning");
    expect(bodies[1]).not.toHaveProperty("reasoning");
  });
});
