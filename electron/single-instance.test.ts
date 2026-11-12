import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { registerSingleInstance } from "./single-instance";

function fixture(primary = true) {
  const events = new EventEmitter();
  const shown: string[] = [];
  const state = { recording: false, quitting: false };
  const ready = registerSingleInstance(
    {
      requestSingleInstanceLock: () => primary,
      on: (event, listener) => events.on(event, listener),
    },
    {
      isQuitting: () => state.quitting,
      isRecording: () => state.recording,
      showRecorder: () => shown.push("recorder"),
      showRecordingControls: () => shown.push("controls"),
    },
  );
  return { events, shown, state, ready };
}

test("a duplicate does not register activation handlers or reveal windows", () => {
  const f = fixture(false);
  assert.equal(f.ready, null);
  assert.deepEqual(f.events.eventNames(), []);
  f.events.emit("second-instance");
  assert.deepEqual(f.shown, []);
});

test("launches during startup coalesce and reveal the current recording state", () => {
  const f = fixture();
  f.events.emit("second-instance");
  f.events.emit("activate");
  f.events.emit("second-instance");
  assert.deepEqual(f.shown, []);

  f.state.recording = true;
  f.ready?.();
  f.ready?.();
  assert.deepEqual(f.shown, ["controls"]);
});

test("repeated launches reveal the existing UI without changing recording state", () => {
  const f = fixture();
  f.ready?.();
  assert.deepEqual(f.shown, []);
  f.events.emit("second-instance");
  assert.deepEqual(f.shown, ["recorder"]);

  f.state.recording = true;
  f.events.emit("second-instance");
  f.events.emit("activate");
  assert.deepEqual(f.shown, ["recorder", "controls", "controls"]);
  assert.equal(f.state.recording, true);
});

test("activation does not reopen windows during shutdown", () => {
  const f = fixture();
  f.events.emit("second-instance");
  f.state.quitting = true;
  f.ready?.();
  f.events.emit("second-instance");
  f.events.emit("activate");
  assert.deepEqual(f.shown, []);

  f.state.quitting = false;
  f.events.emit("second-instance");
  assert.deepEqual(f.shown, ["recorder"]);
});
