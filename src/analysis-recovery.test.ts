import assert from "node:assert/strict";
import test from "node:test";

import { AnalysisRecovery, completeSignIn } from "./analysis-recovery";
import type { CopilotSignInResult } from "../common/ipc";

function interrupted(guard: AnalysisRecovery) {
  const run = guard.beginRun();
  assert.ok(run);
  guard.finishRun(run, true);
  return run;
}

test("verified sign-in can reserve exactly one retry of the original signed-out analysis", () => {
  const guard = new AnalysisRecovery();
  const original = interrupted(guard);
  assert.equal(guard.beginSignIn(original), true);
  assert.equal(guard.beginSignIn(original), false);
  assert.equal(guard.beginRun(), null);
  const retry = guard.retry(original);
  assert.ok(retry);
  assert.equal(retry.retried, true);
  assert.equal(guard.retry(original), null);
  assert.equal(guard.beginRun(), null);
  guard.finishRun(retry, true);
  assert.equal(guard.beginSignIn(retry), false);
  assert.equal(guard.retry(retry), null);
});

test("ordinary errors and successful analyses never become recoverable", () => {
  const guard = new AnalysisRecovery();
  const run = guard.beginRun();
  assert.ok(run);
  guard.finishRun(run, false);
  assert.equal(guard.beginSignIn(run), false);
  assert.equal(guard.retry(run), null);
});

test("cancel discards the pending authentication continuation", () => {
  const guard = new AnalysisRecovery();
  const run = interrupted(guard);
  assert.equal(guard.beginSignIn(run), true);
  guard.endSignIn(run);
  assert.equal(guard.retry(run), null);
  assert.equal(guard.beginSignIn(run), false);
  assert.ok(guard.beginRun());
});

test("an unsuccessful sign-in can be attempted again without spending the analysis retry", () => {
  const guard = new AnalysisRecovery();
  const original = interrupted(guard);
  guard.beginSignIn(original);
  guard.endSignIn(original, false);
  assert.equal(guard.retry(original), null);
  assert.equal(guard.beginSignIn(original), true);
  const retry = guard.retry(original);
  assert.ok(retry);
  guard.finishRun(retry, true);
  assert.equal(guard.beginSignIn(retry), false);
});

test("a competing manual run supersedes the previous error and stale completion", () => {
  const guard = new AnalysisRecovery();
  const original = interrupted(guard);
  const manual = guard.beginRun();
  assert.ok(manual);
  assert.equal(guard.beginRun(), null);
  assert.equal(guard.beginSignIn(original), false);
  guard.finishRun(original, true);
  assert.equal(guard.accepts(manual), true);
  guard.finishRun(manual, true);
  assert.equal(guard.beginSignIn(manual), true);
  assert.equal(guard.retry(original), null);
  assert.ok(guard.retry(manual));
});

test("canceling analysis ignores its result and cannot release its lock prematurely", () => {
  const guard = new AnalysisRecovery();
  const run = guard.beginRun();
  assert.ok(run);
  guard.cancelRun();
  assert.equal(guard.accepts(run), false);
  assert.equal(guard.isCurrent(run), true);
  assert.equal(guard.beginRun(), null);
  guard.finishRun(run, true);
  assert.equal(guard.beginSignIn(run), false);
  assert.ok(guard.beginRun());
});

test("unmount and session switch invalidate old runs and late authentication", () => {
  const guard = new AnalysisRecovery();
  const original = interrupted(guard);
  guard.beginSignIn(original);
  guard.invalidate();
  assert.equal(guard.retry(original), null);
  const current = guard.beginRun();
  assert.ok(current);
  guard.finishRun(original, true);
  guard.endSignIn(original);
  assert.equal(guard.accepts(current), true);
  guard.invalidate();
  assert.equal(guard.accepts(current), false);
  assert.equal(guard.isCurrent(current), false);
});

test("late sign-in cleanup cannot interrupt the automatic retry", () => {
  const guard = new AnalysisRecovery();
  const original = interrupted(guard);
  guard.beginSignIn(original);
  const retry = guard.retry(original);
  assert.ok(retry);
  guard.endSignIn(original);
  assert.equal(guard.accepts(retry), true);
  guard.finishRun(retry, false);
  const next = guard.beginRun();
  assert.ok(next);
  assert.equal(next.retried, false);
});

test("the continuation waits for verified authentication rather than browser launch", async () => {
  let finish!: (result: CopilotSignInResult) => void;
  const result = new Promise<CopilotSignInResult>((resolve) => { finish = resolve; });
  let calls = 0;
  const completion = completeSignIn(result, () => true, () => { calls++; });
  await Promise.resolve();
  assert.equal(calls, 0);
  finish({ ok: true, status: "authenticated" });
  assert.deepEqual(await completion, { ok: true, status: "authenticated" });
  assert.equal(calls, 1);
});

test("canceled, failed, timed-out and stale sign-ins do not call the continuation", async () => {
  let calls = 0;
  const callback = () => { calls++; };
  for (const status of ["canceled", "failed", "timed-out"] as const) {
    await completeSignIn(Promise.resolve({ ok: false, status }), () => true, callback);
  }
  let live = true;
  let finish!: (result: CopilotSignInResult) => void;
  const result = new Promise<CopilotSignInResult>((resolve) => { finish = resolve; });
  const completion = completeSignIn(result, () => live, callback);
  live = false;
  finish({ ok: true, status: "authenticated" });
  assert.equal(await completion, null);
  assert.equal(calls, 0);
});

test("IPC rejections and thrown or rejected callbacks reach the banner's error handler", async () => {
  await assert.rejects(
    completeSignIn(Promise.reject(new Error("IPC unavailable")), () => true),
    /IPC unavailable/,
  );
  for (const callback of [
    () => { throw new Error("retry failed"); },
    async () => { throw new Error("retry failed"); },
  ]) {
    await assert.rejects(
      completeSignIn(Promise.resolve({ ok: true, status: "authenticated" }), () => true, callback),
      /retry failed/,
    );
  }
});

test("panels without a continuation only report authentication", async () => {
  const result = { ok: true, status: "authenticated" } as const;
  assert.equal(await completeSignIn(Promise.resolve(result), () => true), result);
});

test("a continuation that leaves the panel suppresses its stale success UI", async () => {
  let live = true;
  const completion = completeSignIn(
    Promise.resolve({ ok: true, status: "authenticated" }),
    () => live,
    () => { live = false; },
  );
  assert.equal(await completion, null);
});
