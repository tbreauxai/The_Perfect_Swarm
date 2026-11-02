import { describe, it, expect, vi, afterEach } from "vitest";
import { AsyncJobStore, wantsAsync, newJobId, ASYNC_JOB_TTL_MS } from "./asyncJobs.ts";

const req = (prefer?: string) => ({ req: { header: (k: string) => (k === "Prefer" ? prefer : undefined) } });

describe("asyncJobs", () => {
    afterEach(() => vi.restoreAllMocks());

    it("wantsAsync only for Prefer: respond-async", () => {
        expect(wantsAsync(req())).toBe(false);
        expect(wantsAsync(req("return=minimal"))).toBe(false);
        expect(wantsAsync(req("respond-async"))).toBe(true);
        expect(wantsAsync(req("Respond-Async, wait=5"))).toBe(true);
    });

    it("newJobId keeps the engine's wf-<ms> shape plus a suffix", () => {
        expect(newJobId("wf", 1700000000000)).toMatch(/^wf-1700000000000-[0-9a-f]{8}$/);
    });

    it("pending -> done, owner-scoped", async () => {
        const s = new AsyncJobStore(() => 1000);
        let release!: (v: unknown) => void;
        s.start("j1", "duelodds", () => new Promise((r) => { release = r; }));
        expect(s.get("j1", "duelodds")?.status).toBe("pending");
        expect(s.get("j1", "other")).toBeUndefined();
        await Promise.resolve();
        release({ ok: 1 });
        await s.drain();
        expect(s.get("j1", "duelodds")).toMatchObject({ status: "done", result: { ok: 1 }, finishedAt: 1000 });
    });

    it("a throwing job is caught, logged and stored as error", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const s = new AsyncJobStore(() => 1000);
        s.start("j2", "duelodds", async () => { throw new Error("boom"); });
        await s.drain();
        expect(s.get("j2", "duelodds")).toMatchObject({ status: "error", error: "boom" });
        expect(err).toHaveBeenCalledTimes(1);
    });

    it("finished jobs expire after the TTL; pending jobs never do", async () => {
        let t = 0;
        const s = new AsyncJobStore(() => t);
        s.start("done", "a", async () => 1);
        s.start("slow", "a", () => new Promise(() => {}));
        await new Promise((r) => setImmediate(r));
        expect(s.get("done", "a")?.status).toBe("done");
        t = ASYNC_JOB_TTL_MS + 1;
        expect(s.get("done", "a")).toBeUndefined();
        expect(s.get("slow", "a")?.status).toBe("pending");
    });
});
