#!/usr/bin/env node
/**
 * Startup smoke test: boots the server with the REAL Render start command (the Dockerfile CMD,
 * `node --experimental-strip-types server.ts`, read from the Dockerfile), waits for GET /api/health
 * to return 200 {status:"ok"}, then stops it. Exits 0 on success, 1 on failure (and prints the server log).
 * Catches what unit tests can't: syntax Node's strip-only mode rejects (parameter properties, enums,
 * namespaces, ...) and broken runtime imports anywhere in the server.ts import graph.
 * Env is stubbed: no provider keys (no outbound calls), NODE_ENV=production, a smoke app token.
 * Run `npm run build` first (production mode serves ./dist).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.SMOKE_PORT || 3999);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 30000);

const cmdLine = readFileSync("Dockerfile", "utf8")
  .split("\n")
  .filter((l) => /^CMD\s+\[/.test(l))
  .pop();
if (!cmdLine) {
  console.error("[smoke] no exec-form CMD [...] line in Dockerfile");
  process.exit(1);
}
const [bin, ...args] = JSON.parse(cmdLine.replace(/^CMD\s+/, ""));
console.log(
  `[smoke] start command (Dockerfile CMD): ${[bin, ...args].join(" ")}  PORT=${PORT}`,
);

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "production",
  PORT: String(PORT),
  SWARM_APP_TOKENS: "smoke:smoke-token",
};
const child = spawn(bin === "node" ? process.execPath : bin, args, {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => {
  log += d;
});
child.stderr.on("data", (d) => {
  log += d;
});
let exited = null;
child.on("exit", (code, signal) => {
  exited = { code, signal };
});

const fail = (msg) => {
  console.error(
    `[smoke] FAIL: ${msg}\n----- server log -----\n${log}\n----------------------`,
  );
  if (!exited) child.kill("SIGKILL");
  process.exit(1);
};

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  if (exited)
    fail(`server exited early (code ${exited.code}, signal ${exited.signal})`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.status === "ok") {
      console.log(`[smoke] GET /api/health -> 200 ${JSON.stringify(body)}`);
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!exited) child.kill("SIGKILL");
      console.log("[smoke] PASS");
      process.exit(0);
    }
    fail(`GET /api/health -> ${res.status} ${JSON.stringify(body)}`);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
fail(`no healthy response within ${TIMEOUT_MS} ms`);
