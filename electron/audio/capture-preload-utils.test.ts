import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { handleRecorderStop } = require("./capture-preload-utils.cjs");

test("audio stop reports a rejected chunk flush", async () => {
  const events: unknown[][] = [];
  let cleaned = false;
  await handleRecorderStop({
    sendChain: Promise.reject(new Error("chunk flush failed")),
    id: "segment-0001",
    getStopEpoch: () => 123,
    cleanup: () => {
      cleaned = true;
    },
    send: (...args: unknown[]) => {
      events.push(args);
    },
  });
  assert.equal(cleaned, true);
  assert.deepEqual(events, [
    ["audio:error", "segment-0001", "chunk flush failed", "Error"],
    ["audio:stopped", "segment-0001", 123],
  ]);
});

test("audio stop acknowledges a successful chunk flush", async () => {
  const events: unknown[][] = [];
  let cleaned = false;
  await handleRecorderStop({
    sendChain: Promise.resolve(),
    id: "segment-0001",
    getStopEpoch: () => 123,
    cleanup: () => {
      cleaned = true;
    },
    send: (...args: unknown[]) => {
      events.push(args);
    },
  });
  assert.equal(cleaned, true);
  assert.deepEqual(events, [["audio:stopped", "segment-0001", 123]]);
});
