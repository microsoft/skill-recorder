import assert from "node:assert/strict";
import test from "node:test";

import {
  initialSkillReviewState,
  SkillOperationGuard,
  skillReviewBusy,
  skillReviewReducer as reduce,
} from "./skill-review-state";

const preview = { id: "candidate-1", markdown: "---\nname: example\n---\n<script>not rendered</script>\n" };
const reviewed = () => reduce(
  reduce(initialSkillReviewState(false), { type: "visibility", open: true }),
  { type: "preview", preview },
);

test("direct placement skips review and finishes on the shared done surface", () => {
  const creating = reduce(initialSkillReviewState(false), { type: "start", phase: "creating", message: "Writing…" });
  assert.equal(creating.reviewOpen, false);
  assert.equal(creating.preview, null);
  const done = reduce(creating, { type: "done" });
  assert.equal(done.phase, "done");
  assert.equal(done.reviewOpen, false);
  assert.equal(skillReviewBusy(done.phase), false);
});

test("close and reopen retain the exact candidate and do not change operation status", () => {
  const closed = reduce(reviewed(), { type: "visibility", open: false });
  assert.equal(closed.preview, preview);
  assert.equal(closed.phase, "plan");
  const opened = reduce(closed, { type: "visibility", open: true });
  assert.equal(opened.preview, preview);
  assert.equal(opened.preview?.markdown, preview.markdown);
  const preparing = reduce(opened, { type: "start", phase: "preparing", message: "Preparing…" });
  const hidden = reduce(preparing, { type: "visibility", open: false });
  assert.equal(hidden.phase, "preparing");
  assert.equal(skillReviewBusy(hidden.phase), true);
  assert.equal(reduce(hidden, { type: "preview", preview }).reviewOpen, false);
});

test("export cancellation preserves the open review and candidate without an error", () => {
  const creating = reduce(reviewed(), { type: "start", phase: "creating", message: "Exporting…" });
  const canceled = reduce(creating, { type: "settle", phase: "plan" });
  assert.equal(canceled.preview, preview);
  assert.equal(canceled.reviewOpen, true);
  assert.equal(canceled.error, null);
  assert.equal(canceled.phase, "plan");
});

test("placement failure retains the candidate and shared error for retry from either surface", () => {
  for (const open of [true, false]) {
    const ready = reduce(reviewed(), { type: "visibility", open });
    const failed = reduce(ready, { type: "settle", phase: "plan", error: "Write failed" });
    assert.equal(failed.preview, preview);
    assert.equal(failed.error, "Write failed");
    assert.equal(failed.reviewOpen, open);
    const retrying = reduce(failed, { type: "start", phase: "creating", message: "Writing…" });
    assert.equal(retrying.error, null);
    const done = reduce(retrying, { type: "done" });
    assert.equal(done.phase, "done");
    assert.equal(done.reviewOpen, false);
    assert.equal(done.preview, null);
  }
});

test("plan invalidation drops the candidate without blocking edits", () => {
  const invalidated = reduce(reviewed(), { type: "invalidate" });
  assert.equal(invalidated.preview, null);
  assert.equal(invalidated.phase, "plan");
  assert.equal(skillReviewBusy(invalidated.phase), false);
});

test("expired placement clears the local candidate while retaining the error and explicit review retry", () => {
  for (const open of [true, false]) {
    const ready = reduce(reviewed(), { type: "visibility", open });
    const creating = reduce(ready, { type: "start", phase: "creating", message: "Writing…" });
    const expired = reduce(creating, {
      type: "settle", phase: "plan", previewExpired: true, error: "Preview expired. Review again.",
    });
    assert.equal(expired.preview, null);
    assert.equal(expired.reviewOpen, open);
    assert.equal(expired.error, "Preview expired. Review again.");
    assert.equal(expired.phase, "plan");
    assert.equal(skillReviewBusy(expired.phase), false);
    const reopened = reduce(reduce(expired, { type: "visibility", open: false }), { type: "visibility", open: true });
    assert.equal(reopened.preview, null);
    assert.equal(reopened.error, expired.error);
    const retry = reduce(reopened, { type: "start", phase: "preparing", message: "Preparing…" });
    assert.equal(retry.phase, "preparing");
    assert.equal(retry.error, null);
  }
});

test("generation failure and cancellation return to the plan without accepting a preview", () => {
  const preparing = reduce(initialSkillReviewState(false), { type: "start", phase: "preparing", message: "Preparing…" });
  const failed = reduce(preparing, { type: "settle", phase: "plan", error: "IPC failed" });
  assert.equal(failed.phase, "plan");
  assert.equal(failed.preview, null);
  assert.equal(failed.error, "IPC failed");
  const stopping = reduce(preparing, { type: "start", phase: "stopping", message: "Stopping…" });
  assert.equal(skillReviewBusy(stopping.phase), true);
  assert.equal(reduce(stopping, { type: "settle", phase: "plan" }).error, null);
});

test("synchronous operation guard rejects double clicks and releases only the matching operation", () => {
  const guard = new SkillOperationGuard();
  const first = guard.begin()!;
  assert.equal(guard.begin(), null);
  assert.equal(guard.isCurrent(first), true);
  guard.finish(Symbol());
  assert.equal(guard.busy, true);
  guard.finish(first);
  assert.equal(guard.busy, false);
  assert.ok(guard.begin());
});

test("cancellation or departure makes late results stale without unlocking newer work", () => {
  const guard = new SkillOperationGuard();
  const old = guard.begin()!;
  assert.equal(guard.invalidate(), true);
  const next = guard.begin()!;
  assert.equal(guard.isCurrent(old), false);
  guard.finish(old);
  assert.equal(guard.isCurrent(next), true);
  assert.equal(guard.begin(), null);
  guard.invalidate();
  assert.equal(guard.isCurrent(next), false);
  assert.equal(guard.invalidate(), false);
});

test("cancellation acknowledgement cannot release the lock before the original request settles", async () => {
  const guard = new SkillOperationGuard();
  const original = guard.begin()!;
  const { originalSettled, operation: cancellation } = guard.beginCancellation()!;
  let stopped = false;
  const stop = (async () => {
    await Promise.resolve(); // cancelSkill acknowledged, but generation/picker is still pending.
    await originalSettled;
    stopped = true;
    guard.finish(cancellation);
  })();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(guard.busy, true);
  assert.equal(guard.begin(), null);
  assert.equal(guard.isCurrent(original), false);
  guard.finish(original);
  await stop;
  assert.equal(stopped, true);
  assert.equal(guard.busy, false);
  assert.ok(guard.begin());
});

test("committed placement wins a cancellation race and keeps the shared done screen", async () => {
  const guard = new SkillOperationGuard();
  const placement = guard.begin()!;
  let state = reduce(reviewed(), { type: "start", phase: "creating", message: "Writing…" });
  const cancellation = guard.beginCancellation()!;
  state = reduce(state, { type: "start", phase: "stopping", message: "Stopping…" });
  assert.equal(guard.isCurrent(placement), false);
  // createSkill reports success after the synchronous write beat cancellation.
  assert.equal(guard.commit(placement), true);
  state = reduce(state, { type: "done" });
  guard.finish(placement);
  await cancellation.originalSettled;
  // The cancellation continuation must not put the completed UI back on its plan.
  if (guard.isCurrent(cancellation.operation)) {
    state = reduce(state, { type: "settle", phase: "plan" });
  }
  guard.finish(cancellation.operation);
  assert.equal(state.phase, "done");
  assert.equal(state.preview, null);
  assert.equal(state.reviewOpen, false);
  assert.equal(guard.busy, false);
});

test("departed or superseded placements cannot report a committed success", () => {
  const guard = new SkillOperationGuard();
  const old = guard.begin()!;
  guard.beginCancellation();
  guard.invalidate();
  const next = guard.begin()!;
  assert.equal(guard.commit(old), false);
  assert.equal(guard.isCurrent(next), true);
  guard.finish(old);
  assert.equal(guard.isCurrent(next), true);
});

test("departed operation completion does not unlock a fresh builder instance", async () => {
  const previousView = new SkillOperationGuard();
  const departed = previousView.begin()!;
  const settled = previousView.whenSettled();
  previousView.invalidate();
  const freshView = new SkillOperationGuard();
  const current = freshView.begin()!;
  previousView.finish(departed);
  await settled;
  assert.equal(previousView.isCurrent(departed), false);
  assert.equal(freshView.isCurrent(current), true);
  assert.equal(freshView.begin(), null);
});
