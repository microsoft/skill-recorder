import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CopilotClient } from "@github/copilot-sdk";
import { AiConnectionError, parseByomConfig } from "../common/ai-provider";
import { AiProviderStore } from "./ai-provider-store";
import { AiConnectionService, byomRuntimeConfig, connectAiClient, createAiSession, providerError, type AiRuntimeConfig } from "./ai-provider";

const profile = parseByomConfig({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "my-deployment", wireApi: "responses" });
const key = "test-only-key";

async function fixture(
  t: TestContext,
  probe?: (config: AiRuntimeConfig, signal: AbortSignal) => Promise<void>,
  checkExistingGitHubAuth: (signal: AbortSignal) => Promise<boolean> = async () => false,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-runtime-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "connection.json");
  const store = new AiProviderStore(() => file, {
    available: () => false,
    encrypt: () => { throw new Error("unavailable"); },
    decrypt: () => { throw new Error("unavailable"); },
  });
  const service = new AiConnectionService(store, () => path.join(dir, "runtime"), probe ?? (async () => {}), checkExistingGitHubAuth);
  return { store, service, file };
}

test("upgrading without a provider preference restores an existing GitHub login once", async (t) => {
  let checks = 0;
  const f = await fixture(t, undefined, async () => { checks++; return true; });
  const [first, second, runtime] = await Promise.all([
    f.service.status(), f.service.status(), f.service.configuration(),
  ]);
  assert.equal(first.mode, "github");
  assert.equal(second.mode, "github");
  assert.equal(runtime.byom, false);
  assert.equal(runtime.client.baseDirectory, undefined, "Keep the original CLI credential location.");
  assert.equal(checks, 1);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { version: 1, mode: "github" });
});

test("users without an existing GitHub login still see the chooser", async (t) => {
  let checks = 0;
  const f = await fixture(t, undefined, async () => { checks++; return false; });
  assert.equal((await f.service.status()).mode, null);
  await assert.rejects(f.service.configuration(), /Choose an AI connection/);
  assert.equal(checks, 1);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("saved GitHub and BYOM choices are never reprobed or replaced on upgrade", async (t) => {
  const f = await fixture(t, undefined, async () => { assert.fail("Existing choices must not query GitHub."); });
  await f.store.select("github");
  assert.equal((await f.service.status()).mode, "github");

  const byom = await fixture(t, undefined, async () => { assert.fail("BYOM must not query GitHub."); });
  await byom.store.saveByom(profile, key);
  await byom.store.forget();
  const status = await byom.service.status();
  assert.equal(status.mode, "byom");
  assert.equal(status.hasKey, false);
  await assert.rejects(byom.service.configuration(), /Choose an AI connection/);
});

test("failed legacy-login checks leave setup available and surface only a safe warning", async (t) => {
  const f = await fixture(t, undefined, async () => { throw new Error("private-auth-response"); });
  const status = await f.service.status();
  assert.equal(status.mode, null);
  assert.match(status.warning!, /Choose GitHub authentication to retry/);
  assert.equal(JSON.stringify(status).includes("private-auth-response"), false);
  assert.equal((await f.service.saveByom("save", 1, profile, key)).ok, true);
  assert.equal((await f.service.status()).warning, undefined);
});

test("an explicit BYOM choice waits for migration and then wins without a storage race", async (t) => {
  let entered!: () => void;
  let finish!: (authenticated: boolean) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(t, undefined, async () => {
    entered();
    return new Promise<boolean>((resolve) => { finish = resolve; });
  });
  const status = f.service.status();
  await started;
  const save = f.service.saveByom("save", 1, profile, key);
  finish(true);
  await status;
  assert.equal((await save).ok, true);
  assert.equal((await f.service.configuration()).byom, true);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).mode, "byom");
});

test("explicit BYOM setup does not start a legacy-login check", async (t) => {
  const f = await fixture(t, undefined, async () => { assert.fail("Explicit BYOM must not query GitHub."); });
  assert.equal((await f.service.saveByom("save", 1, profile, key)).ok, true);
  assert.equal((await f.service.status()).mode, "byom");
});

test("shutdown cancels migration without persisting a late authentication result", async (t) => {
  let finish!: (authenticated: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(t, undefined, async () => {
    entered();
    return new Promise<boolean>((resolve) => { finish = resolve; });
  });
  const checking = f.service.status();
  await started;
  f.service.dispose();
  finish(true);
  assert.equal((await checking).mode, null);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("BYOM maps every protocol and strips ambient GitHub authentication", (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-github-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  for (const provider of ["foundry", "azure", "openai", "anthropic", "custom"] as const) {
    const config = byomRuntimeConfig({ ...profile, provider, apiVersion: "2024-10-21" }, key, "runtime");
    assert.equal(config.client.useLoggedInUser, false);
    assert.equal(config.client.mode, "empty");
    assert.equal(config.client.env?.GH_TOKEN, undefined);
    assert.equal(config.session.model, "my-deployment");
    assert.equal(config.session.modelCapabilities?.supports?.vision, true);
    assert.equal(config.session.provider?.apiKey, key);
    assert.equal(config.session.provider?.type, provider === "azure" ? "azure" : provider === "anthropic" ? "anthropic" : "openai");
    assert.equal(config.session.provider?.azure?.apiVersion, provider === "azure" ? "2024-10-21" : undefined);
  }
});

test("BYOM startup does not query GitHub auth; session creation receives the explicit provider", async (t) => {
  t.mock.method(CopilotClient.prototype, "start", async () => {});
  const auth = t.mock.method(CopilotClient.prototype, "getAuthStatus", async () => { throw new Error("must not query GitHub"); });
  t.mock.method(CopilotClient.prototype, "forceStop", async () => {});
  const runtime = byomRuntimeConfig(profile, key, "runtime");
  const client = await connectAiClient(runtime, "Test");
  assert.equal(auth.mock.callCount(), 0);
  const create = t.mock.method(client, "createSession", async () => { throw new Error(`401 ${key}`); });
  await assert.rejects(createAiSession(client, { onPermissionRequest: async () => ({ kind: "approved" }) }, runtime), (error: unknown) => {
    assert.ok(error instanceof AiConnectionError);
    assert.equal(error.code, "authentication");
    assert.equal(error.message.includes(key), false);
    return true;
  });
  const args = create.mock.calls[0].arguments[0];
  assert.ok(args);
  assert.equal(args.model, profile.model);
  assert.equal(args.provider?.apiKey, key);
});

test("unconfigured mode requires the chooser and failed probes preserve the old connection", async (t) => {
  const f = await fixture(t, async () => { throw new Error(`429 ${key}`); });
  await assert.rejects(f.service.configuration(), /Choose an AI connection/);
  await f.store.select("github");
  const result = await f.service.saveByom("test", 1, profile, key);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "quota");
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal((await f.store.status()).mode, "github");
});

test("changing providers excludes active work and resets clients before committing", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const running = f.service.run(() => new Promise<void>((resolve) => { release = resolve; }));
  assert.equal((await f.service.saveByom("test", 1, profile, key)).ok, false);
  release();
  await running;
  let resets = 0;
  f.service.bind(async () => { resets++; }, () => {});
  assert.equal((await f.service.saveByom("test", 1, profile, key)).ok, true);
  assert.equal(resets, 1);
  assert.equal((await f.service.configuration()).byom, true);
  assert.equal((await f.service.saveByom("test2", 1, { ...profile, baseUrl: "https://other.example/v1" }, undefined)).ok, false);
  assert.equal((await f.service.forget("test3", 1)).ok, true);
  assert.equal(resets, 2);
  await assert.rejects(f.service.configuration(), /Choose an AI connection/);
});

test("cancellation belongs to its window and cannot commit a canceled connection", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(t, async (_config, signal) => {
    entered();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const saving = f.service.saveByom("test", 7, profile, key);
  await started;
  await assert.rejects(f.service.run(async () => {}), /Finish AI connection/);
  f.service.cancel("test", 8);
  assert.equal((await f.store.status()).mode, null);
  f.service.cancel("test", 7);
  const result = await saving;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "canceled");
  assert.equal((await f.store.status()).hasKey, false);
});

test("provider failures are categorized without echoing response bodies", () => {
  for (const [message, code] of [
    ["401 secret", "authentication"], ["404 secret", "model"], ["429 secret", "quota"],
    ["unsupported image secret", "capability"], ["network secret", "connection"],
  ]) {
    const error = providerError(new Error(message));
    assert.equal(error.code, code);
    assert.equal(error.message.includes("secret"), false);
  }
});
