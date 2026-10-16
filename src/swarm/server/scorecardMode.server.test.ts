import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createSwarmServer } from "./app.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { globalProviderLimiter } from "../providers/limiter.ts";

const DATA = [
  "id|event|pick|mkt|line|odds|fairP|modelP|ev",
  "R1|NYY @ BOS 10-16 18:10|NYY|ml|-|-120|0.530|0.560|2.1",
  "R2|NYY @ BOS 10-16 18:10|BOS|ml|-|+102|0.470|0.440|-3.0",
  "R3|SENTINEL-SERVER-ROW|X|ml|-|+100|0.500|0.500|0.0",
].join("\n");

const agents = [
  {
    id: "manager",
    role: "Manager Node",
    provider: "srv-manager-mock",
    model: "m",
  },
  { id: "a1", role: "Line Analyst", provider: "srv-analyst-mock", model: "m" },
];

describe("R2-S3 server: /analyze and /stream in scorecard mode", () => {
  let app: any;
  let managerPrompts: string[] = [];

  beforeEach(() => {
    globalProviderLimiter.reset();
    managerPrompts = [];
    ProviderRegistry.register({
      providerName: "srv-analyst-mock",
      async call(o: any) {
        if (o.prompt.includes("OUTPUT FORMAT (scorecard mode")) {
          return JSON.stringify({
            seat: "a1",
            picks: [{ row: "R1", note: "value" }],
            edge: 2.1,
            key_risk: "k",
            confidence: 0.6,
            status: "ok",
          });
        }
        return JSON.stringify({ insights: ["i"], anomalies: [], summary: "s" });
      },
    } as any);
    ProviderRegistry.register({
      providerName: "srv-manager-mock",
      async call(o: any) {
        managerPrompts.push(o.prompt);
        return JSON.stringify({
          ui_title: "Board",
          summary: "Leg R1.",
          components: [],
        });
      },
    } as any);
    const baseApp = createSwarmServer({
      defaultSettings: { appId: "test-app" },
    });
    app = new Hono();
    app.use("*", async (c: any, next: any) => {
      c.set("callerAppId", "test-app");
      c.env = {
        SWARM_APP_TOKENS: "test-app:test-token-123",
        SWARM_AUTH_REQUIRED: "true",
      };
      await next();
    });
    app.route("/", baseApp);
  });

  const body = (scorecardMode?: boolean, appId = "r2-srv") =>
    JSON.stringify({
      task: "Pick the best leg",
      data: DATA,
      bypassCache: true,
      forceFullSwarm: true,
      enableDeepAnalysis: false,
      ...(scorecardMode === undefined ? {} : { scorecardMode }),
      agents,
      settings: { appId, disableFallback: true },
    });

  it("/analyze with scorecardMode:true returns the blackboard alongside finalAnalysis", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/swarm/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body(true, "r2-srv-analyze"),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.finalAnalysis.ui_title).toBe("Board");
    expect(data.blackboard.citedRows).toEqual([
      {
        row: "R1",
        line: "R1|NYY @ BOS 10-16 18:10|NYY|ml|-|-120|0.530|0.560|2.1",
      },
    ]);
    expect(data.status).toBe("complete");
    expect(managerPrompts[0]).not.toContain("SENTINEL-SERVER-ROW");
  });

  it("/stream emits a swarm_stage scorecard frame and the blackboard on swarm_complete", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/swarm/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body(true, "r2-srv-stream"),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = text.split("\n\n");
    const stageFrames = frames
      .filter((f) => f.includes("event: swarm_stage"))
      .map((f) =>
        JSON.parse(
          f
            .split("\n")
            .find((l) => l.startsWith("data: "))!
            .slice(6),
        ),
      );
    const scorecardFrame = stageFrames.find((s) => s.stage === "scorecard");
    expect(scorecardFrame).toMatchObject({
      seat: "a1",
      scorecard: { picks: [{ row: "R1", note: "value" }] },
    });
    const complete = frames.find((f) => f.includes("event: swarm_complete"))!;
    const payload = JSON.parse(
      complete
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice(6),
    );
    expect(payload.blackboard.scorecards[0].seat).toBe("a1");
    expect(payload.workflowId).toBeTruthy();
  });

  it("without scorecardMode the response has no blackboard", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/swarm/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body(undefined, "r2-srv-classic"),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.blackboard).toBeUndefined();
  });
});
