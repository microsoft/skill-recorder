import assert from "node:assert/strict";
import test from "node:test";

import {
  abortable,
  SignInCoordinator,
  SignInError,
  type SignInOperations,
} from "./copilot-signin-flow";

function fixture(overrides: Partial<SignInOperations> = {}) {
  const calls: string[] = [];
  const operations: SignInOperations = {
    hasMicrosoftHint: async () => { calls.push("hint"); return false; },
    chooseAccount: async () => { calls.push("choose"); return "microsoft"; },
    prepareEnterprise: async () => { calls.push("enterprise"); return true; },
    login: async () => { calls.push("login"); },
    verifyAuthentication: async () => { calls.push("verify"); return true; },
    manualCommand: "copilot --no-auto-update login --web-flow",
    ...overrides,
  };
  return { calls, operations };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("unknown user sees no enterprise choice and succeeds only after verification", async () => {
  const { calls, operations } = fixture();
  const result = await new SignInCoordinator().signIn("attempt", 1, operations);
  assert.deepEqual(result, { ok: true, status: "authenticated" });
  assert.deepEqual(calls, ["hint", "login", "verify"]);
});

test("positive hint offers choice, with enterprise SSO before CLI authorization", async () => {
  const entered = deferred<void>();
  const sso = deferred<boolean>();
  const { calls, operations } = fixture({
    hasMicrosoftHint: async () => true,
    prepareEnterprise: () => {
      calls.push("enterprise");
      entered.resolve();
      return sso.promise;
    },
  });
  const result = new SignInCoordinator().signIn("attempt", 1, operations);
  await entered.promise;
  assert.deepEqual(calls, ["choose", "enterprise"]);
  sso.resolve(true);
  assert.equal((await result).ok, true);
  assert.deepEqual(calls, ["choose", "enterprise", "login", "verify"]);
});

test("personal choice does not open the enterprise URL", async () => {
  const { calls, operations } = fixture({
    hasMicrosoftHint: async () => true,
    chooseAccount: async () => "personal",
  });
  await new SignInCoordinator().signIn("attempt", 1, operations);
  assert.deepEqual(calls, ["login", "verify"]);
});

test("canceling account choice or enterprise preparation never starts login", async () => {
  for (const choice of ["canceled", "microsoft"] as const) {
    const { calls, operations } = fixture({
      hasMicrosoftHint: async () => true,
      chooseAccount: async () => choice,
      prepareEnterprise: async () => false,
    });
    assert.deepEqual(await new SignInCoordinator().signIn("attempt", 1, operations), {
      ok: false, status: "canceled",
    });
    assert.deepEqual(calls, []);
  }
});

test("launch completion cannot resolve the attempt before login exits and auth is verified", async () => {
  const login = deferred<void>();
  const verification = deferred<boolean>();
  const verifying = deferred<void>();
  const { operations } = fixture({
    login: () => login.promise,
    verifyAuthentication: () => { verifying.resolve(); return verification.promise; },
  });
  let finished = false;
  const result = new SignInCoordinator().signIn("attempt", 1, operations);
  void result.then(() => { finished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  login.resolve();
  await verifying.promise;
  assert.equal(finished, false);
  verification.resolve(true);
  assert.equal((await result).ok, true);
});

test("zero login exit with unauthenticated SDK status is a failure, not success", async () => {
  const { operations } = fixture({ verifyAuthentication: async () => false });
  const result = await new SignInCoordinator().signIn("attempt", 1, operations);
  assert.equal(result.status, "failed");
  if (!result.ok) assert.match(result.error!, /still signed out/);
});

test("auth errors do not expose raw CLI output or retry automatically", async () => {
  const { calls, operations } = fixture({
    login: async () => { throw new Error("secret raw CLI output"); },
  });
  const result = await new SignInCoordinator().signIn("attempt", 1, operations);
  assert.equal(result.status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /secret raw/);
  assert.deepEqual(calls, ["hint"]);
});

test("authored errors and a non-secret manual fallback are surfaced", async () => {
  const { operations } = fixture({
    login: async () => { throw new SignInError("Could not start login."); },
  });
  assert.deepEqual(await new SignInCoordinator().signIn("attempt", 1, operations), {
    ok: false, status: "failed", error: "Could not start login.", command: operations.manualCommand,
  });
});

test("single flight rejects duplicates and cancellation requires matching attempt and owner", async () => {
  const entered = deferred<void>();
  let aborted = false;
  const { calls, operations } = fixture({
    login: async (signal) => {
      entered.resolve();
      try { await abortable(new Promise<void>(() => {}), signal); }
      finally { aborted = true; }
    },
  });
  const coordinator = new SignInCoordinator();
  const result = coordinator.signIn("first", 1, operations);
  await entered.promise;
  assert.equal((await coordinator.signIn("second", 2, operations)).status, "failed");
  coordinator.cancel("first", 2);
  coordinator.cancel("second", 1);
  assert.equal(aborted, false);
  coordinator.cancel("first", 1);
  assert.equal((await result).status, "canceled");
  assert.equal(aborted, true);
  assert.deepEqual(calls, ["hint"]);
  assert.equal((await coordinator.signIn("third", 1, fixture().operations)).ok, true);
});

test("timeout during a hint/choice cannot launch a late login", async () => {
  const hint = deferred<boolean>();
  const { calls, operations } = fixture({ hasMicrosoftHint: () => hint.promise });
  const result = await new SignInCoordinator(10).signIn("attempt", 1, operations);
  assert.equal(result.status, "timed-out");
  hint.resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test("timeout aborts active login and waits for its cleanup", async () => {
  let cleaned = false;
  const { calls, operations } = fixture({
    login: async (signal) => {
      try { await abortable(new Promise<void>(() => {}), signal); }
      finally { cleaned = true; }
    },
  });
  const result = await new SignInCoordinator(10).signIn("attempt", 1, operations);
  assert.equal(result.status, "timed-out");
  assert.equal(cleaned, true);
  assert.deepEqual(calls, ["hint"]);
});

test("shutdown invalidates login and prevents verification", async () => {
  const started = deferred<void>();
  const { calls, operations } = fixture({
    login: async (signal) => {
      started.resolve();
      await abortable(new Promise<void>(() => {}), signal);
    },
  });
  const coordinator = new SignInCoordinator();
  const result = coordinator.signIn("attempt", 1, operations);
  await started.promise;
  coordinator.dispose();
  assert.equal((await result).status, "canceled");
  assert.deepEqual(calls, ["hint"]);
});

test("cancel during SDK verification cannot report authenticated", async () => {
  const verifying = deferred<void>();
  const { operations } = fixture({
    verifyAuthentication: async (signal) => {
      verifying.resolve();
      return abortable(new Promise<boolean>(() => {}), signal);
    },
  });
  const coordinator = new SignInCoordinator();
  const result = coordinator.signIn("attempt", 1, operations);
  await verifying.promise;
  coordinator.cancel("attempt", 1);
  assert.equal((await result).status, "canceled");
});
