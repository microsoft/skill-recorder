import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import AdmZip from "adm-zip";

import { writeDebugBundle } from "./debug-bundle";

test("writeDebugBundle zips the whole session under session/ next to debug-info.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-debug-"));
  const previousRoot = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;

  try {
    const id = "debug-test";
    const dir = path.join(root, id);
    await mkdir(path.join(dir, "frames"), { recursive: true });
    await writeFile(path.join(dir, "session.json"), JSON.stringify({ id }));
    await writeFile(path.join(dir, "events.jsonl"), '{"seq":0}\n');
    await writeFile(path.join(dir, "frames", "event_1000.jpg"), Buffer.alloc(8, 7));

    const dest = path.join(root, "bundle.zip");
    await writeDebugBundle(id, dest, { sessionId: id, marker: "diagnostics" });

    assert.ok(existsSync(dest), "zip file should be written");
    const head = await readFile(dest);
    assert.deepEqual(
      [...head.subarray(0, 4)],
      [0x50, 0x4b, 0x03, 0x04],
      "output should start with the ZIP local-file-header magic",
    );

    const names = new AdmZip(dest).getEntries().map((entry) => entry.entryName);
    assert.ok(names.includes("debug-info.json"), "carries a top-level debug-info.json");
    assert.ok(
      names.includes("session/session.json"),
      "nests the recording's files under session/",
    );
    assert.ok(
      names.includes("session/frames/event_1000.jpg"),
      "includes nested session artifacts (frames, etc.)",
    );
  } finally {
    if (previousRoot === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("writeDebugBundle refuses a traversal session id", async () => {
  await assert.rejects(
    async () => writeDebugBundle("../escape", path.join(tmpdir(), "x.zip"), {}),
    /Invalid session id/,
  );
});
