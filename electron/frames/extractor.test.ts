import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";

import type { CapturedVideoFrame } from "../../common/frames";
import { FrameExtractor, nearestCapturedFrame, sampleCapturedFrames } from "./extractor";

const frame = (file: string, tMs: number): CapturedVideoFrame => ({
  file,
  tMs,
  offsetMs: tMs - 1000,
  width: 1280,
  height: 720,
});

test("nearestCapturedFrame chooses the closest source and prefers the earlier tie", () => {
  const frames = [frame("a.jpg", 1000), frame("b.jpg", 2000), frame("c.jpg", 3000)];
  assert.equal(nearestCapturedFrame(frames, 1750)?.file, "b.jpg");
  assert.equal(nearestCapturedFrame(frames, 2500)?.file, "b.jpg");
  assert.equal(nearestCapturedFrame(frames, 500)?.file, "a.jpg");
  assert.equal(nearestCapturedFrame(frames, 5000)?.file, "c.jpg");
});

test("sampleCapturedFrames never duplicates a 1 fps source when asked for 6 fps", () => {
  const frames = [
    frame("a.jpg", 1000),
    frame("b.jpg", 2000),
    frame("c.jpg", 3000),
    frame("d.jpg", 4000),
  ];
  const samples = sampleCapturedFrames(frames, 1000, 4000, 6, 24);
  assert.deepEqual(samples.map((sample) => sample.frame.file), [
    "a.jpg",
    "b.jpg",
    "c.jpg",
    "d.jpg",
  ]);
  assert.equal(new Set(samples.map((sample) => sample.frame.file)).size, samples.length);
});

test("sampleCapturedFrames returns the nearest static heartbeat for an empty window", () => {
  const samples = sampleCapturedFrames([frame("only.jpg", 1000)], 5000, 6000, 1, 4);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].frame.file, "only.jpg");
  assert.equal(samples[0].targetMs, 5000);
});

test("FrameExtractor safely reuses one portable source snapshot for multiple events", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-frames-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "video-frames");
  const framesDir = path.join(root, "frames");
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(framesDir, { recursive: true }),
  ]);
  await writeFile(path.join(sourceDir, "source.jpg"), "test frame");
  const manifestPath = path.join(root, "video-frames.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      format: "jpeg",
      heartbeatMs: 5000,
      frames: [
        null,
        {
          file: "video-frames\\source.jpg",
          tMs: 1600,
          offsetMs: 600,
          width: 1280,
          height: 720,
        },
      ],
    }),
  );

  const extractor = new FrameExtractor({
    capturedFramesPath: manifestPath,
    framesDir,
    anchorEpochMs: 1000,
  });
  const added = await extractor.extractAtEpochs([{ tMs: 1500 }, { tMs: 2500 }]);

  assert.equal(added.length, 1);
  assert.equal(extractor.manifest.length, 1);
  assert.equal(added[0].tMs, 1600);
  assert.equal(added[0].offsetSec, 0.6);
  assert.equal(existsSync(path.join(framesDir, added[0].file)), true);
});

test("FrameExtractor drops malformed retained frame records", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-retained-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "frames.json"),
    JSON.stringify([
      null,
      {
        file: "event_500.jpg",
        tMs: 1500,
        offsetSec: 0.5,
        source: "event",
        phash: "",
      },
    ]),
  );

  const extractor = new FrameExtractor({ framesDir: root, anchorEpochMs: 1000 });
  assert.deepEqual(extractor.manifest.map((entry) => entry.file), ["event_500.jpg"]);
});

test("FrameExtractor deduplicates identical source JPEGs without deleting retained files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-dedupe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "video-frames");
  const framesDir = path.join(root, "frames");
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(framesDir, { recursive: true }),
  ]);
  const jpeg = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 30, g: 90, b: 150 },
    },
  })
    .jpeg()
    .toBuffer();
  await Promise.all([
    writeFile(path.join(sourceDir, "one.jpg"), jpeg),
    writeFile(path.join(sourceDir, "two.jpg"), jpeg),
  ]);
  const manifestPath = path.join(root, "video-frames.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      format: "jpeg",
      heartbeatMs: 5000,
      frames: [
        { file: "video-frames/one.jpg", tMs: 1600, offsetMs: 600, width: 32, height: 32 },
        { file: "video-frames/two.jpg", tMs: 3600, offsetMs: 2600, width: 32, height: 32 },
      ],
    }),
  );
  const options = {
    capturedFramesPath: manifestPath,
    framesDir,
    anchorEpochMs: 1000,
  };
  const events = [{ tMs: 1600 }, { tMs: 3600 }];
  const extractor = new FrameExtractor(options);

  assert.equal((await extractor.extractAtEpochs(events)).length, 1);
  assert.equal(extractor.manifest.length, 1);
  assert.equal(existsSync(path.join(framesDir, extractor.manifest[0].file)), true);
  assert.equal((await extractor.extractAtEpochs(events)).length, 0);

  const reloaded = new FrameExtractor(options);
  assert.equal((await reloaded.extractAtEpochs(events)).length, 0);
  assert.equal(reloaded.manifest.length, 1);
  assert.equal(existsSync(path.join(framesDir, reloaded.manifest[0].file)), true);
});

test("a hung legacy ffmpeg process is killed and rejects within its timeout instead of hanging forever", async () => {
  // extractLegacyWindow/extractLegacySingle bound their execFileAsync calls with
  // LEGACY_FFMPEG_TIMEOUT_MS so a stalled ffmpeg (corrupt input, codec edge case,
  // stuck pipe) can't hang the extraction indefinitely. Those methods are private
  // and resolve their ffmpeg binary through a module-level, cached `which`/`where`
  // lookup that isn't test-injectable without expanding this fix's scope, so this
  // exercises the same execFileAsync-with-timeout mechanism directly: a child
  // process that never exits on its own must still be killed and the call must
  // still reject well within the timeout, not hang.
  const execFileAsync = promisify(execFile);
  const start = Date.now();
  await assert.rejects(
    execFileAsync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 200 }),
  );
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 5000, `expected the timeout to bound the hang, took ${elapsedMs}ms`);
});

test("sharp loads through the app's require path as a callable factory (guards sharp 0.35 export shape)", async () => {
  // The frame extractor loads sharp with createRequire(import.meta.url)("sharp"), which
  // resolves sharp's CommonJS "require" export condition. sharp 0.35 split its import and
  // require export shapes, so this guards that the require path stays a directly-callable
  // factory exposing the .extract().jpeg() pipeline the extractor depends on.
  const requireFromHere = createRequire(import.meta.url);
  const loaded = requireFromHere("sharp") as typeof sharp;
  assert.equal(typeof loaded, "function");
  const cropped = await loaded({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .extract({ left: 1, top: 1, width: 4, height: 4 })
    .jpeg({ quality: 88 })
    .toBuffer();
  assert.ok(cropped.length > 0);
});

