import assert from "node:assert/strict";
import test from "node:test";

import { verifyCopilotAuthentication } from "./copilot-signin-auth";

test("verification uses a fresh client and stops it after reading actual authentication", async () => {
  let clients = 0;
  const calls: string[] = [];
  const createClient = () => {
    clients++;
    return {
      start: async () => { calls.push("start"); },
      getAuthStatus: async () => { calls.push("status"); return { isAuthenticated: clients === 2 }; },
      forceStop: async () => { calls.push("stop"); },
    };
  };
  assert.equal(await verifyCopilotAuthentication(createClient, new AbortController().signal), false);
  assert.equal(await verifyCopilotAuthentication(createClient, new AbortController().signal), true);
  assert.equal(clients, 2);
  assert.deepEqual(calls, ["start", "status", "stop", "start", "status", "stop"]);
});

test("startup and status failures always stop the client and sanitize errors", async () => {
  for (const phase of ["start", "status"]) {
    let stopped = false;
    await assert.rejects(verifyCopilotAuthentication(() => ({
      start: async () => { if (phase === "start") throw new Error("private startup output"); },
      getAuthStatus: async () => { throw new Error("private status output"); },
      forceStop: async () => { stopped = true; },
    }), new AbortController().signal), /^Error: Could not verify Copilot authentication/);
    assert.equal(stopped, true);
  }
});

test("cancellation during startup stops the client without querying authentication", async () => {
  const controller = new AbortController();
  let stopped = false;
  await assert.rejects(verifyCopilotAuthentication(() => ({
    start: async () => { controller.abort(); },
    getAuthStatus: async () => { assert.fail("must not query canceled client"); },
    forceStop: async () => { stopped = true; },
  }), controller.signal), /Could not verify Copilot authentication/);
  assert.equal(stopped, true);
});

test("an already canceled request never constructs an SDK client", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(verifyCopilotAuthentication(() => {
    assert.fail("must not construct");
  }, controller.signal), { name: "AbortError" });
});

test("a hung SDK times out and is force-stopped", async () => {
  let stopped = false;
  // AbortSignal.timeout is unref'd; keep the mock process alive like a real CLI.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(verifyCopilotAuthentication(() => ({
      start: () => new Promise<void>(() => {}),
      getAuthStatus: async () => { assert.fail("must not query unstarted client"); },
      forceStop: async () => { stopped = true; },
    }), new AbortController().signal, 10), /Could not verify Copilot authentication/);
    assert.equal(stopped, true);
  } finally {
    clearInterval(keepAlive);
  }
});
