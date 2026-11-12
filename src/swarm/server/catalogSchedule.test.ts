import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chicagoParts, scheduledChicagoProbeDateKey } from "./app.ts";
import { clearCatalogCache, ensureCatalogProbeFresh } from "./modelsProvider.ts";
import { QdrantLearningStore } from "../learning-persistence.ts";

describe("daily Chicago model catalog schedule", () => {
  beforeEach(() => {
    clearCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    ));
  });

  afterEach(() => {
    clearCatalogCache();
    vi.unstubAllGlobals();
  });

  it.each([
    ["2026-03-08T08:00:00Z", "2026-03-08"],
    ["2026-11-01T09:00:00Z", "2026-11-01"],
  ])("converts %s to the repeated-safe 3 AM Chicago hour", (timestamp, dateKey) => {
    const parts = chicagoParts(new Date(timestamp));
    expect(parts).toEqual({ dateKey, hour: 3 });
    expect(scheduledChicagoProbeDateKey(new Date(timestamp), "")).toBe(dateKey);
    expect(scheduledChicagoProbeDateKey(new Date(timestamp), dateKey)).toBeNull();
  });

  it("catches up when no probe exists or the last probe is older than 24 hours", async () => {
    const now = Date.parse("2026-11-12T20:00:00Z");
    for (const lastProbeAt of [undefined, now - 24 * 60 * 60 * 1000 - 1]) {
      clearCatalogCache();
      const store = {
        loadCatalogState: vi.fn(async () => ({
          ...(lastProbeAt !== undefined ? { lastProbeAt } : {}),
          providers: {},
        })),
        saveCatalogState: vi.fn(async (_state: Record<string, any>) => {}),
      };

      await Promise.all([
        ensureCatalogProbeFresh({}, store as unknown as QdrantLearningStore, now),
        ensureCatalogProbeFresh({}, store as unknown as QdrantLearningStore, now),
      ]);

      expect(store.loadCatalogState).toHaveBeenCalledOnce();
      expect(store.saveCatalogState).toHaveBeenCalledOnce();
    }
  });

  it("does not catch up when the last successful probe is at most 24 hours old", async () => {
    const now = Date.parse("2026-11-12T20:00:00Z");
    const store = {
      loadCatalogState: vi.fn(async () => ({
        lastProbeAt: now - 24 * 60 * 60 * 1000,
        providers: {},
      })),
      saveCatalogState: vi.fn(async (_state: Record<string, any>) => {}),
    };

    await ensureCatalogProbeFresh({}, store as unknown as QdrantLearningStore, now);

    expect(store.saveCatalogState).not.toHaveBeenCalled();
  });
});
