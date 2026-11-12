import { describe, it, expect, afterEach, vi } from "vitest";
import { OpenRouterAdapter } from "./openrouter.ts";

const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b:free";
const NEUTRAL = "google/gemma-4-31b-it:free";

describe("OpenRouter model routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the Nemotron Ultra id unchanged", async () => {
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
    expect(bodies[0].model).toBe(ULTRA);
  });

  it("retries without response_format if model returns 400 format error", async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (bodies.length === 1) {
          return new Response("Unsupported parameter: response_format", { status: 400 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"status":"ok_openrouter"}' } }],
          }),
          { status: 200 },
        );
      }),
    );
    const result = await new OpenRouterAdapter().call({
      modelName: NEUTRAL,
      prompt: "hi",
      apiKey: "sk-or-v1-test",
      config: { responseMimeType: "application/json" },
    } as any);

    expect(bodies.length).toBe(2);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].response_format).toBeUndefined();
    expect(result).toBe('{"status":"ok_openrouter"}');
  });

  it("transparently falls back to openrouter/free when upstream Nvidia endpoint returns 404", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (body.model === NEUTRAL) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Provider returned error",
                code: 404,
                metadata: { provider_name: "Nvidia" },
              },
            }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"status":"fallback_ok"}' } }],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await new OpenRouterAdapter().call({
      modelName: NEUTRAL,
      prompt: "hi",
      apiKey: "sk-or-v1-test",
    } as any);

    expect(bodies.length).toBe(2);
    expect(bodies[0].model).toBe(NEUTRAL);
    expect(bodies[1].model).toBe("openrouter/free");
    expect(result).toBe('{"status":"fallback_ok"}');
  });
});
