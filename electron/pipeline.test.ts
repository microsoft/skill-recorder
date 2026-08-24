import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionBundle } from "../common/bundle";
import type { RecEvent, SessionMeta } from "../common/types";
import { processSession } from "./pipeline";

test("processSession skips legacy video-only frame extraction", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const startedAt = 1_000;
  const meta: SessionMeta = {
    id: "legacy-video-only",
    startedAt,
    stoppedAt: startedAt + 1_000,
    platform: process.platform,
    appVersion: "0.6.0-test",
  };
  const event: RecEvent = {
    seq: 1,
    t: 100,
    epoch: startedAt + 100,
    type: "app.activate",
    source: "test",
    payload: { app: "Example", title: "Legacy recording" },
  };
  await Promise.all([
    writeFile(path.join(root, "session.json"), JSON.stringify(meta)),
    writeFile(path.join(root, "events.jsonl"), `${JSON.stringify(event)}\n`),
    writeFile(
      path.join(root, "video.json"),
      JSON.stringify({
        file: "screen.webm",
        startEpoch: startedAt,
        durationMs: 1_000,
      }),
    ),
    writeFile(path.join(root, "screen.webm"), "legacy video placeholder"),
  ]);

  const lookupMarker = path.join(root, "ffmpeg-lookup-attempted");
  const restoreLookup = await installFfmpegLookupTrap(root, lookupMarker);

  try {
    await processSession(root);
  } finally {
    restoreLookup();
  }

  assert.equal(existsSync(lookupMarker), false, "legacy ffmpeg discovery must not run");
  const bundle = JSON.parse(
    await readFile(path.join(root, "bundle.json"), "utf8"),
  ) as SessionBundle;
  assert.equal(bundle.stats.frameCount, 0);
  assert.equal(bundle.stats.stepCount, 1);
  assert.equal(existsSync(path.join(root, "description.md")), true);
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function installFfmpegLookupTrap(root: string, marker: string): Promise<() => void> {
  const binDir = path.join(root, "bin");
  await mkdir(binDir);
  const previousPath = process.env.PATH;
  const previousNodeOptions = process.env.NODE_OPTIONS;

  if (process.platform === "win32") {
    const preload = path.join(root, "mark-ffmpeg-lookup.cjs");
    await writeFile(
      preload,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");\n`,
    );
    const fakeWhere = path.join(binDir, "where.exe");
    try {
      await link(process.execPath, fakeWhere);
    } catch {
      await copyFile(process.execPath, fakeWhere);
    }
    const requirePreload = `--require=${JSON.stringify(preload)}`;
    process.env.NODE_OPTIONS = [previousNodeOptions, requirePreload].filter(Boolean).join(" ");
  } else {
    const fakeWhich = path.join(binDir, "which");
    await writeFile(
      fakeWhich,
      `#!/bin/sh\nprintf called > ${shellQuote(marker)}\nexit 1\n`,
    );
    await chmod(fakeWhich, 0o755);
  }
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  };
}
