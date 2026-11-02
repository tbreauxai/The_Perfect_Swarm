import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("../engine/index.ts", async (orig) => {
    const real: any = await orig();
    return { ...real, executeSwarmWorkflow: execMock };
});

import { createSwarmServer } from "./app.ts";
import { globalAsyncJobs } from "./asyncJobs.ts";

const T0 = new Date("2026-11-02T03:02:00Z");

function makeApp(appId = "duelodds") {
    const base = createSwarmServer({ defaultSettings: { appId: "duelodds" } });
    const app = new Hono();
    app.use("*", async (c: any, next: any) => { c.set("callerAppId", appId); await next(); });
    app.route("/", base);
    return app;
}
const post = (prefer?: string) =>
    new Request("http://localhost/api/swarm/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
        body: JSON.stringify({ task: "judge", data: { g: 1 } }),
    });

describe("async /api/swarm/analyze", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network blocked in test"); }));
        execMock.mockReset();
    });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it("without Prefer stays sync 200", async () => {
        execMock.mockResolvedValue({ workflowId: "wf-1", finalAnswer: "x" });
        const res = await makeApp().fetch(post());
        expect(res.status).toBe(200);
        expect((await res.json()).workflowId).toBe("wf-1");
    });

    it("Prefer: respond-async -> 202 then status pending -> done with the same workflowId", async () => {
        let finish!: () => void;
        execMock.mockImplementation((p: any) => new Promise((r) => {
            finish = () => r({ workflowId: p.context.id, finalAnswer: "ok", big: 5n });
        }));
        const app = makeApp();
        const res = await app.fetch(post("respond-async"));
        expect(res.status).toBe(202);
        expect(res.headers.get("Preference-Applied")).toBe("respond-async");
        const { workflowId, status } = await res.json();
        expect(status).toBe("pending");
        expect(workflowId).toMatch(new RegExp(`^wf-${T0.getTime()}-[0-9a-f]{8}$`));
        expect(res.headers.get("Location")).toBe(`/api/swarm/analyze/status/${workflowId}`);

        const statusUrl = `http://localhost/api/swarm/analyze/status/${workflowId}`;
        await vi.waitFor(() => expect(execMock).toHaveBeenCalledTimes(1));
        expect(await (await app.fetch(new Request(statusUrl))).json()).toEqual({ status: "pending" });

        finish();
        await globalAsyncJobs.drain();
        const done = await (await app.fetch(new Request(statusUrl))).json();
        expect(done.status).toBe("done");
        expect(done.result).toMatchObject({ workflowId, finalAnswer: "ok", big: "5", status: "complete", degraded: [] });

        // Another app cannot read it.
        expect((await makeApp("other").fetch(new Request(statusUrl))).status).toBe(404);
    });

    it("workflow error is caught and reported as status error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        execMock.mockRejectedValue(new Error("groq 429"));
        const app = makeApp();
        const { workflowId } = await (await app.fetch(post("respond-async"))).json();
        await globalAsyncJobs.drain();
        const body = await (await app.fetch(new Request(`http://localhost/api/swarm/analyze/status/${workflowId}`))).json();
        expect(body).toEqual({ status: "error", error: "groq 429" });
    });

    it("validation stays sync 400 and unknown ids 404", async () => {
        const app = makeApp();
        const bad = await app.fetch(new Request("http://localhost/api/swarm/analyze", {
            method: "POST", headers: { Prefer: "respond-async", "Content-Type": "application/json" }, body: "{}",
        }));
        expect(bad.status).toBe(400);
        expect((await app.fetch(new Request("http://localhost/api/swarm/analyze/status/wf-nope"))).status).toBe(404);
        expect(execMock).not.toHaveBeenCalled();
    });
});
