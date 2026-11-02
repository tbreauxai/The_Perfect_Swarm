import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const { slateMock } = vi.hoisted(() => ({ slateMock: vi.fn() }));
vi.mock("../morning/index.ts", async (orig) => {
    const real: any = await orig();
    return { ...real, runMorningSlate: slateMock };
});

import { createSwarmServer } from "./app.ts";
import { globalAsyncJobs } from "./asyncJobs.ts";
import { tryAcquireMorningLock, releaseMorningLock } from "../morning/index.ts";

const T0 = new Date("2026-11-02T03:42:00Z");

function makeApp() {
    const base = createSwarmServer({ defaultSettings: { appId: "duelodds" } });
    const app = new Hono();
    app.use("*", async (c: any, next: any) => { c.set("callerAppId", "duelodds"); await next(); });
    app.route("/", base);
    return app;
}
const post = (prefer?: string) =>
    new Request("http://localhost/api/swarm/morning", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
        body: JSON.stringify({ date: "2026-11-01" }),
    });

describe("async /api/swarm/morning", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network blocked in test"); }));
        slateMock.mockReset();
    });
    afterEach(async () => { await globalAsyncJobs.drain(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it("202 immediately, lock held until the run settles, result via status", async () => {
        let finish!: () => void;
        slateMock.mockImplementation((args: any) => new Promise((r) => { finish = () => r({ date: args.dateInput, judged: 3 }); }));
        const app = makeApp();
        const res = await app.fetch(post("respond-async"));
        expect(res.status).toBe(202);
        const { workflowId } = await res.json();
        expect(workflowId).toMatch(new RegExp(`^morning-${T0.getTime()}-[0-9a-f]{8}$`));

        // Second call while running: unchanged single-flight reply.
        const second = await app.fetch(post("respond-async"));
        expect(second.status).toBe(202);
        expect(await second.json()).toEqual({ status: "already_running" });

        await vi.waitFor(() => expect(slateMock).toHaveBeenCalledTimes(1));
        finish();
        await globalAsyncJobs.drain();
        const body = await (await app.fetch(new Request(`http://localhost/api/swarm/analyze/status/${workflowId}`))).json();
        expect(body).toEqual({ status: "done", result: { date: "2026-11-01", judged: 3 } });
        expect(tryAcquireMorningLock()).toBe(true); // released
        releaseMorningLock();
    });

    it("a failed background run releases the lock and reports error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        slateMock.mockRejectedValue(new Error("supabase down"));
        const app = makeApp();
        const { workflowId } = await (await app.fetch(post("respond-async"))).json();
        await globalAsyncJobs.drain();
        const body = await (await app.fetch(new Request(`http://localhost/api/swarm/analyze/status/${workflowId}`))).json();
        expect(body).toEqual({ status: "error", error: "supabase down" });
        expect(tryAcquireMorningLock()).toBe(true);
        releaseMorningLock();
    });

    it("without Prefer stays sync 200", async () => {
        slateMock.mockResolvedValue({ judged: 1 });
        const res = await makeApp().fetch(post());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ judged: 1 });
        expect(tryAcquireMorningLock()).toBe(true);
        releaseMorningLock();
    });
});
