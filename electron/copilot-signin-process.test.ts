import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCopilotCliPath } from "./copilot-cli-path";
import { copilotSignInCommand, runCopilotLogin } from "./copilot-signin-process";

test("login runs the bundled executable without a shell, terminal, or writable stdin", async () => {
  await runCopilotLogin("C:\\Program Files\\Recorder & More\\copilot.exe", new AbortController().signal,
    (file, args, options) => {
      assert.equal(file, "C:\\Program Files\\Recorder & More\\copilot.exe");
      assert.deepEqual(args, ["--no-auto-update", "login", "--web-flow"]);
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, undefined);
      assert.equal(options.detached, undefined);
      assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
      return spawn(process.execPath, ["-e", "process.exit(0)"], options);
    });
});

test("manual commands quote spaces and apostrophes for PowerShell and POSIX shells", () => {
  assert.equal(copilotSignInCommand("C:\\User's files\\copilot.exe", "win32"),
    "& 'C:\\User''s files\\copilot.exe' --no-auto-update login --web-flow");
  assert.equal(copilotSignInCommand("/User's files/copilot", "darwin"),
    "'/User'\\''s files/copilot' --no-auto-update login --web-flow");
});

test("nonzero exit surfaces a safe error and never emits buffered CLI output", async () => {
  await assert.rejects(
    runCopilotLogin("copilot", new AbortController().signal, (_file, _args, options) =>
      spawn(process.execPath, ["-e", "console.error('private output'); process.exit(1)"], options)),
    /Copilot login did not complete/,
  );
});

test("missing executable is a visible failure", async () => {
  await assert.rejects(runCopilotLogin("nonexistent-skill-recorder-test-cli", new AbortController().signal),
    /Could not start the bundled Copilot CLI/);
});

test("cancellation waits for the app-owned child to close", async () => {
  const controller = new AbortController();
  let closed = false;
  const result = runCopilotLogin("copilot", controller.signal, (_file, _args, options) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    child.once("close", () => { closed = true; });
    child.once("spawn", () => controller.abort());
    return child;
  });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(closed, true);
});

test("an already canceled attempt does not start a process", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => runCopilotLogin("copilot", controller.signal, () => {
    assert.fail("must not spawn");
  }), { name: "AbortError" });
});

test("unsupported browser login fails explicitly rather than falling back to device codes", async () => {
  let launches = 0;
  await assert.rejects(runCopilotLogin("copilot", new AbortController().signal, (_file, _args, options) => {
    launches++;
    return spawn(process.execPath, ["-e", `
      process.stderr.write("error: unknown option '--web");
      setTimeout(() => {
        console.error("-flow'");
        process.exitCode = 1;
      }, 20);
    `], options);
  }), /^Error: The bundled Copilot CLI does not support browser authorization\./);
  assert.equal(launches, 1);
});

test("credential storage failure is actionable without revealing raw CLI output", async () => {
  await assert.rejects(runCopilotLogin("copilot", new AbortController().signal,
    (_file, _args, options) => spawn(process.execPath, ["-e", `
      console.error("Login succeeded, but the token was not saved. private details");
      process.exitCode = 1;
    `], options)),
  /^Error: GitHub authorization completed, but the CLI could not save your credentials securely\./);
});

test("the reviewed CLI starts web OAuth without a TTY, device code or real browser", async () => {
  const cliPath = resolveCopilotCliPath();
  assert.ok(cliPath, "install the bundled CLI before running sign-in tests");
  const home = await mkdtemp(path.join(tmpdir(), "skill-recorder-oauth-"));
  let stderr = "";
  const browser = `
    const assert = require("node:assert/strict");
    const url = new URL(process.argv[1]);
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.pathname, "/login/oauth/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.ok(url.searchParams.get("state"));
    const callback = new URL(url.searchParams.get("redirect_uri"));
    assert.equal(callback.protocol, "http:");
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.pathname, "/callback");
    assert.ok(callback.port);
    callback.searchParams.set("state", url.searchParams.get("state"));
    callback.searchParams.set("error", "skill_recorder_web_flow_test");
    require("node:http").get(callback, response => response.resume())
      .on("error", () => process.exitCode = 1)
      .setTimeout(5000, function () { this.destroy(); });
  `;
  try {
    await assert.rejects(runCopilotLogin(cliPath, AbortSignal.timeout(30_000), (file, args, options) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|COPILOT_SDK_AUTH_TOKEN|COPILOT_OFFLINE)$/i.test(key)) {
          delete env[key];
        }
      }
      // The fake browser only denies the loopback callback: no GitHub request,
      // account authorization, user credentials or clipboard access is involved.
      const child = spawn(file, args, {
        ...options,
        env: {
          ...env,
          COPILOT_HOME: home,
          COPILOT_DEBUG_BROWSER: JSON.stringify([process.execPath, "-e", browser]),
        },
      });
      child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
      return child;
    }), /Copilot login did not complete/);
    assert.match(stderr, /skill_recorder_web_flow_test/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
