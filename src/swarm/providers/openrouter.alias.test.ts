import { describe, it, expect, afterEach, vi } from "vitest";
import {
  OpenRouterAdapter,
  resolveOpenRouterModel,
  RETIRED_OPENROUTER_MODELS,
} from "./openrouter.ts";

const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b:free";
const SUPER = "nvidia/nemotron-3-super-120b-a12b:free";

describe("OpenRouter retired-model alias (nemotron-3-ultra → nemotron-3-super :free)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps the dead ultra id to super and leaves every other id alone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(RETIRED_OPENROUTER_MODELS[ULTRA]).toBe(SUPER);
    expect(resolveOpenRouterModel(ULTRA)).toBe(SUPER);
    expect(resolveOpenRouterModel(SUPER)).toBe(SUPER);
    expect(resolveOpenRouterModel("google/gemma-4-31b-it:free")).toBe(
      "google/gemma-4-31b-it:free",
    );
  });

  it("an AI Lab request for the ultra id goes out as super", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
          { status: 200 },
        );
      }),
    );
    await new OpenRouterAdapter().call({
      modelName: ULTRA,
      prompt: "hi",
      apiKey: "sk-or-v1-test",
    } as any);
    expect(bodies[0].model).toBe(SUPER);
  });
});
