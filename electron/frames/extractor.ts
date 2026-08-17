import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import {
  CAPTURED_FRAME_MANIFEST_VERSION,
  type CapturedVideoFrame,
  type FrameRecord,
  type FrameSource,
} from "../../common/frames";
import { createLogger } from "../logger";

const log = createLogger("Frames");
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

type Sharp = (typeof import("sharp"))["default"];
let sharpMod: Sharp | null | undefined;
function sharp(): Sharp | null {
  if (sharpMod === undefined) {
    try {
      sharpMod = require("sharp") as Sharp;
    } catch (err) {
      log.warn("sharp unavailable; frame crops and perceptual dedupe disabled:", message(err));
      sharpMod = null;
    }
  }
  return sharpMod;
}

interface SourceFrame extends CapturedVideoFrame {
  absolutePath: string;
}

export interface ExtractorOptions {
  /** Retained for pre-change recordings that need a system-FFmpeg fallback. */
  videoPath?: string;
  /** Absolute path to the versioned source-frame manifest. */
  capturedFramesPath?: string;
  /** Suppress the system-FFmpeg legacy path for current recordings with no snapshots. */
  capturedFramesExpected?: boolean;
  framesDir: string;
  /** `video.json` startEpoch — the wall-clock anchor for offset↔epoch mapping. */
  anchorEpochMs: number;
  /** Optional known duration (s); guards windows against running past the end. */
  durationSec?: number;
  /** dHash Hamming distance under which two frames count as duplicates. */
  dedupeThreshold?: number;
  /** Hard cap on retained frames, so the adaptive loop cannot run away. */
  maxFrames?: number;
  /** Event anchors within this many seconds collapse to one extraction. */
  frameGridSec?: number;
}

export interface WindowRequest {
  startMs: number;
  endMs: number;
  /** Requested density; source information is capped by the 1 fps recorder. */
  fps?: number;
  maxFrames?: number;
  crop?: { x: number; y: number; w: number; h: number };
  reason?: string;
}

export interface CapturedFrameSample<T extends CapturedVideoFrame = CapturedVideoFrame> {
  frame: T;
  targetMs: number;
}

const DEFAULTS = { dedupeThreshold: 8, maxFrames: 300, frameGridSec: 0.5 };
const DEFAULT_WINDOW_FPS = 1;
const DEFAULT_WINDOW_MAX_FRAMES = 24;
/** Bounds how long a legacy system-ffmpeg extraction can run before it's treated as a failure. */
const LEGACY_FFMPEG_TIMEOUT_MS = 60_000;

export function nearestCapturedFrame<T extends CapturedVideoFrame>(
  frames: readonly T[],
  targetMs: number,
): T | null {
  if (frames.length === 0) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (frames[mid].tMs < targetMs) low = mid + 1;
    else high = mid - 1;
  }
  if (low === 0) return frames[0];
  if (low === frames.length) return frames[frames.length - 1];
  const before = frames[low - 1];
  const after = frames[low];
  return targetMs - before.tMs <= after.tMs - targetMs ? before : after;
}

export function sampleCapturedFrames<T extends CapturedVideoFrame>(
  frames: readonly T[],
  startMs: number,
  endMs: number,
  fps = DEFAULT_WINDOW_FPS,
  maxFrames = DEFAULT_WINDOW_MAX_FRAMES,
): CapturedFrameSample<T>[] {
  if (frames.length === 0) return [];
  const start = Math.max(0, Math.min(startMs, endMs));
  const end = Math.max(start, endMs);
  const density = Number.isFinite(fps) && fps > 0 ? Math.min(fps, 30) : DEFAULT_WINDOW_FPS;
  const cap = Number.isFinite(maxFrames)
    ? Math.max(1, Math.min(Math.floor(maxFrames), DEFAULTS.maxFrames))
    : DEFAULT_WINDOW_MAX_FRAMES;
  const stepMs = 1000 / density;
  const samples: CapturedFrameSample<T>[] = [];
  const used = new Set<string>();

  for (let targetMs = start; targetMs <= end && samples.length < cap; targetMs += stepMs) {
    const frame = nearestCapturedFrame(frames, targetMs);
    if (!frame || used.has(frame.file)) continue;
    used.add(frame.file);
    samples.push({ frame, targetMs: Math.round(targetMs) });
  }
  if (samples.length === 0) {
    const targetMs = Math.round((start + end) / 2);
    const frame = nearestCapturedFrame(frames, targetMs);
    if (frame) samples.push({ frame, targetMs });
  }
  return samples;
}

/**
 * Extracts sparse, visually distinct JPEGs from the snapshots captured alongside
 * the WebM. Pre-change sessions can still use a user-installed FFmpeg, but the
 * application no longer downloads or distributes any FFmpeg binary.
 */
export class FrameExtractor {
  private readonly opts: {
    videoPath?: string;
    capturedFramesPath?: string;
    framesDir: string;
    anchorEpochMs: number;
    durationSec?: number;
    dedupeThreshold: number;
    maxFrames: number;
    frameGridSec: number;
  };
  private readonly manifestPath: string;
  private readonly sourceFrames: SourceFrame[];
  private readonly usesCapturedFramePipeline: boolean;
  private frames: FrameRecord[] = [];
  private warnedLegacy = false;

  constructor(opts: ExtractorOptions) {
    this.opts = {
      ...opts,
      dedupeThreshold: opts.dedupeThreshold ?? DEFAULTS.dedupeThreshold,
      maxFrames: opts.maxFrames ?? DEFAULTS.maxFrames,
      frameGridSec: opts.frameGridSec ?? DEFAULTS.frameGridSec,
    };
    this.manifestPath = path.join(opts.framesDir, "frames.json");
    this.usesCapturedFramePipeline =
      opts.capturedFramesExpected === true ||
      Boolean(opts.capturedFramesPath && existsSync(opts.capturedFramesPath));
    this.sourceFrames = loadSourceFrames(opts.capturedFramesPath);
    if (existsSync(this.manifestPath)) {
      this.frames = loadRetainedFrames(this.manifestPath);
    }
  }

  get manifest(): readonly FrameRecord[] {
    return [...this.frames].sort((a, b) => a.tMs - b.tMs);
  }

  offsetForEpoch(epochMs: number): number {
    return Math.max(0, (epochMs - this.opts.anchorEpochMs) / 1000);
  }

  private epochForOffset(offsetSec: number): number {
    return Math.round(this.opts.anchorEpochMs + offsetSec * 1000);
  }

  async extractAtEpochs(
    events: { tMs: number; reason?: string }[],
    source: FrameSource = "event",
  ): Promise<FrameRecord[]> {
    const gridSec = this.opts.frameGridSec;
    const seen = new Set<number>();
    const seenCapturedFiles = new Set<string>();
    const added: FrameRecord[] = [];
    const sorted = [...events].sort((a, b) => a.tMs - b.tMs);
    for (const event of sorted) {
      const offsetSec = this.offsetForEpoch(event.tMs);
      if (this.opts.durationSec != null && offsetSec > this.opts.durationSec) continue;
      const cell = Math.round(offsetSec / gridSec);
      if (seen.has(cell)) continue;
      seen.add(cell);
      try {
        const record =
          this.sourceFrames.length > 0
            ? await this.extractCapturedAt(
                event.tMs,
                source,
                event.reason,
                seenCapturedFiles,
              )
            : this.usesCapturedFramePipeline
              ? null
              : await this.extractLegacySingle(offsetSec, source, event.reason);
        if (record) added.push(record);
      } catch (err) {
        log.warn(`frame extraction at ${offsetSec.toFixed(2)}s failed:`, message(err));
      }
    }
    this.persist();
    return added;
  }

  async extractWindow(req: WindowRequest): Promise<FrameRecord[]> {
    if (this.sourceFrames.length === 0) {
      return this.usesCapturedFramePipeline ? [] : this.extractLegacyWindow(req);
    }

    const startMs = Math.max(this.opts.anchorEpochMs, req.startMs);
    const endMs = Math.max(startMs, req.endMs);
    const cap = req.maxFrames ?? DEFAULT_WINDOW_MAX_FRAMES;
    const samples = sampleCapturedFrames(
      this.sourceFrames,
      startMs,
      endMs,
      req.fps ?? DEFAULT_WINDOW_FPS,
      cap,
    );
    const stamp = randomUUID();
    const added: FrameRecord[] = [];
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const file = path.join(
        this.opts.framesDir,
        `probe_${stamp}_${String(index + 1).padStart(4, "0")}.jpg`,
      );
      try {
        const rendered = await this.renderCaptured(sample.frame, file, req.crop);
        if (!rendered) continue;
        const record = await this.keepOrDrop(
          file,
          this.offsetForEpoch(sample.frame.tMs),
          "probe",
          req.reason ?? "probe:window",
        );
        if (record) added.push(record);
      } catch (err) {
        log.warn("probe frame failed:", message(err));
      }
    }
    this.persist();
    log.info(
      `probe [${this.offsetForEpoch(startMs).toFixed(1)}–${this.offsetForEpoch(endMs).toFixed(1)}s]: ` +
        `${added.length} new frames`,
    );
    return added;
  }

  private async extractCapturedAt(
    targetMs: number,
    source: FrameSource,
    reason?: string,
    seenCapturedFiles?: Set<string>,
  ): Promise<FrameRecord | null> {
    const captured = nearestCapturedFrame(this.sourceFrames, targetMs) as SourceFrame | null;
    if (!captured) return null;
    if (seenCapturedFiles?.has(captured.file)) return null;

    const offsetSec = this.offsetForEpoch(captured.tMs);
    const name = retainedCapturedName(captured, source);
    const file = path.join(this.opts.framesDir, name);
    const existingIndex = this.frames.findIndex((frame) => frame.file === name);
    if (existingIndex >= 0 && existsSync(file)) {
      seenCapturedFiles?.add(captured.file);
      return null;
    }
    if (existingIndex >= 0) this.frames.splice(existingIndex, 1);

    try {
      await copyFile(captured.absolutePath, file);
      const record = await this.keepOrDrop(file, offsetSec, source, reason);
      seenCapturedFiles?.add(captured.file);
      return record;
    } catch (err) {
      log.warn("captured frame copy failed:", message(err));
      return null;
    }
  }

  private async renderCaptured(
    captured: SourceFrame,
    output: string,
    crop?: WindowRequest["crop"],
  ): Promise<boolean> {
    if (!crop) {
      await copyFile(captured.absolutePath, output);
      return true;
    }
    const image = sharp();
    if (!image) {
      log.warn("probe crop skipped because sharp is unavailable");
      return false;
    }
    const left = Math.round(crop.x);
    const top = Math.round(crop.y);
    const width = Math.round(crop.w);
    const height = Math.round(crop.h);
    if (
      ![left, top, width, height].every(Number.isFinite) ||
      left < 0 ||
      top < 0 ||
      width <= 0 ||
      height <= 0 ||
      left + width > captured.width ||
      top + height > captured.height
    ) {
      throw new Error(
        `Crop ${left},${top},${width},${height} is outside ${captured.width}x${captured.height}.`,
      );
    }
    await image(captured.absolutePath)
      .extract({ left, top, width, height })
      .jpeg({ quality: 88 })
      .toFile(output);
    return true;
  }

  private async extractLegacyWindow(req: WindowRequest): Promise<FrameRecord[]> {
    const ffmpegPath = this.legacyFfmpegPath();
    const videoPath = this.opts.videoPath;
    if (!ffmpegPath || !videoPath) return [];

    const fps = req.fps ?? DEFAULT_WINDOW_FPS;
    const startSec = this.offsetForEpoch(req.startMs);
    const endSec = Math.max(startSec, this.offsetForEpoch(req.endMs));
    const cap = req.maxFrames ?? DEFAULT_WINDOW_MAX_FRAMES;
    const stamp = randomUUID();
    const pattern = path.join(this.opts.framesDir, `probe_${stamp}_%04d.jpg`);
    const filters = [`fps=${fps}`];
    if (req.crop) filters.push(`crop=${req.crop.w}:${req.crop.h}:${req.crop.x}:${req.crop.y}`);

    try {
      await execFileAsync(
        ffmpegPath,
        [
          "-hide_banner",
          "-ss", startSec.toFixed(3),
          "-to", endSec.toFixed(3),
          "-i", videoPath,
          "-vf", filters.join(","),
          "-vsync", "vfr",
          "-frames:v", String(cap),
          "-q:v", "3",
          pattern,
        ],
        // A stalled ffmpeg (corrupt input, codec edge case, stuck pipe) would
        // otherwise hang this promise forever; the timeout bounds that and
        // routes into the same failure handling as any other ffmpeg error.
        { maxBuffer: 32 * 1024 * 1024, timeout: LEGACY_FFMPEG_TIMEOUT_MS },
      );
    } catch (err) {
      log.warn("legacy probe window failed:", message(err));
      return [];
    }

    const added: FrameRecord[] = [];
    for (let index = 1; index <= cap; index++) {
      const file = path.join(
        this.opts.framesDir,
        `probe_${stamp}_${String(index).padStart(4, "0")}.jpg`,
      );
      if (!existsSync(file)) break;
      const offsetSec = startSec + (index - 1) / fps;
      const record = await this.keepOrDrop(
        file,
        offsetSec,
        "probe",
        req.reason ?? "probe:legacy-system-ffmpeg",
      );
      if (record) added.push(record);
    }
    this.persist();
    return added;
  }

  private async extractLegacySingle(
    offsetSec: number,
    source: FrameSource,
    reason?: string,
  ): Promise<FrameRecord | null> {
    const ffmpegPath = this.legacyFfmpegPath();
    const videoPath = this.opts.videoPath;
    if (!ffmpegPath || !videoPath) return null;
    const file = path.join(this.opts.framesDir, `${source}_${Math.round(offsetSec * 1000)}.jpg`);
    try {
      await execFileAsync(
        ffmpegPath,
        [
          "-hide_banner",
          "-i", videoPath,
          "-ss", offsetSec.toFixed(3),
          "-frames:v", "1",
          "-q:v", "3",
          "-y", file,
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: LEGACY_FFMPEG_TIMEOUT_MS },
      );
    } catch (err) {
      log.warn(`legacy frame at ${offsetSec.toFixed(2)}s failed:`, message(err));
      return null;
    }
    if (!existsSync(file)) return null;
    return this.keepOrDrop(file, offsetSec, source, reason);
  }

  private legacyFfmpegPath(): string | null {
    const resolved = systemFfmpegPath();
    if (!resolved && !this.warnedLegacy) {
      this.warnedLegacy = true;
      log.warn(
        "This recording predates captured source frames. Install FFmpeg to extract legacy video frames.",
      );
    }
    return resolved;
  }

  private async keepOrDrop(
    file: string,
    offsetSec: number,
    source: FrameSource,
    reason?: string,
  ): Promise<FrameRecord | null> {
    if (this.frames.length >= this.opts.maxFrames) {
      await unlink(file).catch(() => undefined);
      return null;
    }
    const phash = await dhash(file);
    if (phash) {
      for (const existing of this.frames) {
        if (hamming(existing.phash, phash) <= this.opts.dedupeThreshold) {
          await unlink(file).catch(() => undefined);
          return null;
        }
      }
    }
    const record: FrameRecord = {
      file: path.basename(file),
      tMs: this.epochForOffset(offsetSec),
      offsetSec: Number(offsetSec.toFixed(3)),
      source,
      phash: phash ?? "",
      ...(reason ? { reason } : {}),
    };
    this.frames.push(record);
    return record;
  }

  private persist(): void {
    try {
      writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
    } catch (err) {
      log.warn("failed to persist frames.json:", message(err));
    }
  }
}

function loadSourceFrames(manifestPath?: string): SourceFrame[] {
  if (!manifestPath || !existsSync(manifestPath)) return [];
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      !isRecord(manifest) ||
      manifest.version !== CAPTURED_FRAME_MANIFEST_VERSION ||
      manifest.format !== "jpeg" ||
      !Array.isArray(manifest.frames)
    ) {
      throw new Error("Unsupported captured-frame manifest.");
    }

    const root = path.dirname(manifestPath);
    const frames: SourceFrame[] = [];
    for (const candidate of manifest.frames) {
      if (!isCapturedVideoFrame(candidate)) continue;
      const absolutePath = resolvePortableRelativePath(root, candidate.file);
      if (!absolutePath || !existsSync(absolutePath)) continue;
      frames.push({ ...candidate, absolutePath });
    }
    const ignored = manifest.frames.length - frames.length;
    if (ignored > 0) log.warn(`ignored ${ignored} invalid or missing captured frame(s)`);
    return frames.sort((a, b) => a.tMs - b.tMs);
  } catch (err) {
    log.warn("unreadable captured-frame manifest:", message(err));
    return [];
  }
}

function retainedCapturedName(frame: CapturedVideoFrame, source: FrameSource): string {
  const stem =
    path
      .basename(frame.file, path.extname(frame.file))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80) || "frame";
  return `${source}_${Math.max(0, Math.round(frame.offsetMs))}_${stem}.jpg`;
}

function loadRetainedFrames(manifestPath: string): FrameRecord[] {
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest)) throw new Error("Expected a frame-record array.");
    const frames = manifest.filter(isFrameRecord);
    if (frames.length !== manifest.length) {
      log.warn(`ignored ${manifest.length - frames.length} invalid retained frame record(s)`);
    }
    return frames;
  } catch (err) {
    log.warn("unreadable retained-frame manifest:", message(err));
    return [];
  }
}

function resolvePortableRelativePath(root: string, file: string): string | null {
  if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file)) return null;
  const segments = file.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  const absolute = path.resolve(root, ...segments);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return absolute;
}

function isCapturedVideoFrame(value: unknown): value is CapturedVideoFrame {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    finiteNumber(value.tMs) &&
    finiteNumber(value.offsetMs) &&
    finitePositiveNumber(value.width) &&
    finitePositiveNumber(value.height)
  );
}

function isFrameRecord(value: unknown): value is FrameRecord {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    finiteNumber(value.tMs) &&
    finiteNumber(value.offsetSec) &&
    (value.source === "event" || value.source === "scene" || value.source === "probe") &&
    typeof value.phash === "string" &&
    (value.phash === "" || /^[0-9a-f]{16}$/i.test(value.phash)) &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositiveNumber(value: unknown): value is number {
  return finiteNumber(value) && value > 0;
}

let ffmpegPath: string | null | undefined;
function systemFfmpegPath(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    ffmpegPath =
      execFileSync(finder, ["ffmpeg"], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)[0] || null;
  } catch {
    ffmpegPath = null;
  }
  return ffmpegPath;
}

async function dhash(file: string): Promise<string> {
  const image = sharp();
  if (!image) return "";
  try {
    const width = 9;
    const height = 8;
    const buffer = await image(file)
      .grayscale()
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer();
    let bits = "";
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width - 1; column++) {
        bits +=
          buffer[row * width + column] < buffer[row * width + column + 1] ? "1" : "0";
      }
    }
    let hex = "";
    for (let index = 0; index < 64; index += 4) {
      hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return "";
  }
}

function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let index = 0; index < a.length; index++) {
    let value = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    while (value) {
      distance += value & 1;
      value >>= 1;
    }
  }
  return distance;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
