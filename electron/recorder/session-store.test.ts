import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionMeta } from "../../common/types";
import { SessionStore } from "./session-store";

function makeMeta(id: string): SessionMeta {
  return {
    id,
    startedAt: Date.now(),
    stoppedAt: null,
    platform: process.platform,
    appVersion: "0.0.0-test",
  };
}

type ErrorEmitter = { eventsStream: { emit(event: string, error: Error): boolean } };

test("a write-stream error is captured, not thrown as an uncaught exception", async () => {
  await withSessionsRoot(async () => {
    const store = new SessionStore(makeMeta("20250101-000000-aaaabbbb"));
    const stream = (store as unknown as ErrorEmitter).eventsStream;

    // A Node Writable with no 'error' listener rethrows the error as an uncaught
    // exception — in the main process that is a hard crash of the whole app,
    // mid-recording. The store must own the failure instead of letting it escape.
    assert.doesNotThrow(() =>
      stream.emit("error", new Error("ENOSPC: no space left on device, write")),
    );
    assert.match(store.writeError?.message ?? "", /ENOSPC/);

    // And it must still finalize cleanly afterwards (no hang waiting on close).
    store.finalize(Date.now());
    await store.whenClosed();
  });
});

test("dispose releases the events stream without hanging", async () => {
  await withSessionsRoot(async () => {
    const store = new SessionStore(makeMeta("20250101-000000-ccccdddd"));
    store.append("marker", "test");
    store.dispose();
    await store.whenClosed();
    assert.equal(store.writeError, null);
  });
});

async function withSessionsRoot(run: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-store-"));
  const previous = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
