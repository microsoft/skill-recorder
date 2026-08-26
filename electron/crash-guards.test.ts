import assert from "node:assert/strict";
import test from "node:test";

import { installCrashGuards } from "./crash-guards";

function fakeLog() {
  const errors: string[] = [];
  return {
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      },
    },
    errors,
  };
}

test("installCrashGuards registers process handlers and removes them on dispose", () => {
  const before = process.listenerCount("uncaughtException");
  const beforeRejections = process.listenerCount("unhandledRejection");

  const dispose = installCrashGuards(fakeLog().log);
  assert.equal(process.listenerCount("uncaughtException"), before + 1);
  assert.equal(process.listenerCount("unhandledRejection"), beforeRejections + 1);

  dispose();
  assert.equal(process.listenerCount("uncaughtException"), before);
  assert.equal(process.listenerCount("unhandledRejection"), beforeRejections);
});

test("the uncaughtException guard logs the error and does not rethrow", () => {
  const { log, errors } = fakeLog();
  const before = process.listeners("uncaughtException");
  const dispose = installCrashGuards(log);
  try {
    const added = process
      .listeners("uncaughtException")
      .filter((handler) => !before.includes(handler));
    assert.equal(added.length, 1);
    const handler = added[0] as (err: unknown) => void;
    assert.doesNotThrow(() => handler(new Error("simulated write EPIPE")));
    assert.ok(errors.some((message) => /EPIPE/.test(message)));
  } finally {
    dispose();
  }
});
