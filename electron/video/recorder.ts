import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, desktopCapturer, ipcMain, type IpcMainEvent } from "electron";

import {
  CAPTURED_FRAME_MANIFEST_VERSION,
  type CapturedFrameManifest,
  type CapturedVideoFrame,
} from "../../common/frames";
import { createLogger } from "../logger";

const log = createLogger("Video");
const dirname = path.dirname(fileURLToPath(import.meta.url));
export const VIDEO_FRAMES_FILE = "video-frames.json";
export const VIDEO_FRAMES_DIR = "video-frames";

/** Result metadata written alongside the webm as `video.json`. */
export interface VideoResult {
  file: string;
  /** Wall-clock epoch (ms) when MediaRecorder actually started — the anchor that
   *  maps `event_t → video offset` for frame extraction. */
  startEpoch: number;
  stopEpoch: number;
  durationMs: number;
  bytes: number;
  fps: number;
  /** Present on recordings that use captured snapshots, even when capture yielded none. */
  framesVersion?: number;
  /** Versioned source-frame manifest captured alongside the WebM. */
  framesFile?: string;
  frameCount?: number;
}

// Screen capture's real cost is WindowServer (the OS compositor) grabbing the
// framebuffer at the capture rate — not our encoder. So we keep the rate and
// resolution deliberately low: this is opportunistic enrichment anchored to
// events, never something anyone watches. 1 fps @ 720p is plenty to recover a
// keyframe near each event while keeping the compositor (and the mouse) smooth.
const FPS = 1;
const BITS_PER_SECOND = 500_000;
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const FRAME_HEARTBEAT_MS = 5000;

interface FrameMessage {
  data: Uint8Array;
  tMs: number;
  offsetMs: number;
  width: number;
  height: number;
}

/**
 * Captures a low-fps screen recording for a session. The heavy lifting
 * (getUserMedia + MediaRecorder) happens in a hidden renderer window
 * (electron/video/capture.html + capture-preload.cjs); this class orchestrates
 * it from the main process and writes the webm + `video.json` to the session
 * folder. Capture is strictly best-effort: if there is no screen source or the
 * Screen Recording permission is absent, it logs and the session proceeds
 * without video.
 */
export class VideoRecorder {
  private win: BrowserWindow | null = null;
  private stream: WriteStream | null = null;
  private file = "";
  private dir = "";
  private bytes = 0;
  private startEpoch: number | null = null;
  private stopEpoch: number | null = null;
  private startedResolve: (() => void) | null = null;
  private stoppedResolve: (() => void) | null = null;
  private failed = false;
  private frameDir = "";
  private frameSequence = 0;
  private readonly capturedFrames: CapturedVideoFrame[] = [];
  private readonly frameWrites = new Set<Promise<void>>();

  private readonly onChunk = (e: IpcMainEvent, chunk: Uint8Array) => {
    if (e.sender !== this.win?.webContents || !this.stream) return;
    const buf = Buffer.from(chunk);
    this.bytes += buf.byteLength;
    this.stream.write(buf);
  };

  private readonly onStarted = (e: IpcMainEvent, epoch: number) => {
    if (e.sender !== this.win?.webContents) return;
    this.startEpoch = epoch;
    this.startedResolve?.();
    this.startedResolve = null;
    log.info("recording started; anchor epoch", epoch);
  };

  private readonly onFrame = (e: IpcMainEvent, frame: FrameMessage) => {
    if (e.sender !== this.win?.webContents || !this.frameDir) return;
    if (
      !(frame?.data instanceof Uint8Array) ||
      frame.data.byteLength === 0 ||
      frame.data.byteLength > MAX_FRAME_BYTES ||
      !Number.isFinite(frame.tMs) ||
      !Number.isFinite(frame.offsetMs) ||
      !validFrameDimension(frame.width) ||
      !validFrameDimension(frame.height)
    ) {
      log.warn("ignored captured frame with invalid payload or metadata");
      return;
    }

    const name = `frame_${String(++this.frameSequence).padStart(6, "0")}.jpg`;
    const absolute = path.join(this.frameDir, name);
    const relative = path.posix.join(VIDEO_FRAMES_DIR, name);
    const pending = writeFile(absolute, Buffer.from(frame.data))
      .then(() => {
        this.capturedFrames.push({
          file: relative,
          tMs: Math.round(frame.tMs),
          offsetMs: Math.max(0, Math.round(frame.offsetMs)),
          width: Math.round(frame.width),
          height: Math.round(frame.height),
        });
      })
      .catch((err) => {
        log.warn("failed to persist captured frame:", err instanceof Error ? err.message : err);
      });
    this.frameWrites.add(pending);
    void pending.finally(() => this.frameWrites.delete(pending));
  };

  private readonly onFrameError = (e: IpcMainEvent, message: string) => {
    if (e.sender === this.win?.webContents) log.warn("snapshot capture unavailable:", message);
  };

  private readonly onStopped = (e: IpcMainEvent, epoch: number) => {
    if (e.sender !== this.win?.webContents) return;
    this.stopEpoch = Number.isFinite(epoch) ? epoch : Date.now();
    this.stoppedResolve?.();
  };

  private readonly onError = (e: IpcMainEvent, message: string) => {
    if (e.sender !== this.win?.webContents) return;
    this.failed = true;
    log.warn("capture unavailable:", message);
    this.startedResolve?.();
    this.startedResolve = null;
    // Unblock a pending stop() if the recorder never really started.
    this.stoppedResolve?.();
  };

  /** Begin capturing into `<sessionDir>/video.webm`. Never throws. */
  async start(
    sessionDir: string,
    sourceId?: string,
    displayId?: string,
  ): Promise<void> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (sources.length === 0) {
        log.warn("no screen source available; skipping video");
        return;
      }
      const source = displayId
        ? sources.find((candidate) => candidate.display_id === displayId)
        : sourceId
          ? sources.find((candidate) => candidate.id === sourceId)
          : sources[0];
      if (!source) {
        log.warn("selected screen source is unavailable; skipping video");
        return;
      }

      this.dir = sessionDir;
      this.file = path.join(sessionDir, "video.webm");
      this.bytes = 0;
      this.startEpoch = null;
      this.stopEpoch = null;
      this.failed = false;
      this.frameDir = path.join(sessionDir, VIDEO_FRAMES_DIR);
      this.frameSequence = 0;
      this.capturedFrames.length = 0;
      this.frameWrites.clear();
      await mkdir(this.frameDir, { recursive: true });
      this.stream = createWriteStream(this.file);
      this.stream.on("error", (err) => {
        this.failed = true;
        log.warn("video stream write failed:", err instanceof Error ? err.message : err);
      });

      ipcMain.on("video:chunk", this.onChunk);
      ipcMain.on("video:frame", this.onFrame);
      ipcMain.on("video:frame-error", this.onFrameError);
      ipcMain.on("video:started", this.onStarted);
      ipcMain.on("video:stopped", this.onStopped);
      ipcMain.on("video:error", this.onError);

      this.win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(dirname, "video", "capture-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
        },
      });
      await this.win.loadFile(path.join(dirname, "video", "capture.html"));

      const started = new Promise<void>((resolve) => {
        this.startedResolve = resolve;
      });
      this.win.webContents.send("video:start", {
        sourceId: source.id,
        fps: FPS,
        bitsPerSecond: BITS_PER_SECOND,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
      });
      log.info("capture requested for screen source", source.id, "->", this.file);
      await Promise.race([started, delay(START_TIMEOUT_MS)]);
      if (this.startEpoch == null) {
        log.warn("screen capture did not start; continuing without video");
        await this.teardown();
        await this.removeEmptyArtifacts();
      }
    } catch (err) {
      log.warn("failed to start video:", err instanceof Error ? err.message : err);
      await this.teardown();
      await this.removeEmptyArtifacts();
    }
  }

  /** Stop capturing and return the result, or null if no usable video was produced. */
  async stop(): Promise<VideoResult | null> {
    if (!this.win || !this.stream) {
      await this.teardown();
      await this.removeEmptyArtifacts();
      return null;
    }

    const stopped = new Promise<void>((resolve) => {
      this.stoppedResolve = resolve;
      this.win?.webContents.send("video:stop");
    });
    await Promise.race([stopped, delay(STOP_TIMEOUT_MS)]);

    const stopEpoch = this.stopEpoch ?? Date.now();
    await this.closeStream();
    await Promise.allSettled([...this.frameWrites]);

    const bytes = this.bytes;
    const startEpoch = this.startEpoch;
    const file = this.file;
    const failed = this.failed;
    await this.teardown();

    if (bytes === 0 || startEpoch == null) {
      // Remove a useless/empty file so the session folder stays clean.
      if (existsSync(file)) await unlink(file).catch(() => undefined);
      await rm(this.frameDir, { recursive: true, force: true });
      log.warn("no usable video captured");
      return null;
    }
    if (failed) log.warn("capture ended with an error; preserving the usable partial recording");

    const framesFile = await this.writeFrameManifest();
    const result: VideoResult = {
      file: path.basename(file),
      startEpoch,
      stopEpoch,
      durationMs: stopEpoch - startEpoch,
      bytes,
      fps: FPS,
      framesVersion: CAPTURED_FRAME_MANIFEST_VERSION,
      ...(framesFile ? { framesFile, frameCount: this.capturedFrames.length } : {}),
    };
    await writeFile(path.join(this.dirFor(file), "video.json"), JSON.stringify(result, null, 2)).catch(
      (err) => log.warn("failed to write video.json:", err instanceof Error ? err.message : err),
    );
    log.info(
      `video saved: ${result.file} (${(bytes / 1_000_000).toFixed(1)} MB, ` +
        `${result.durationMs} ms, ${this.capturedFrames.length} source frames)`,
    );
    return result;
  }

  private async writeFrameManifest(): Promise<string | null> {
    if (this.capturedFrames.length === 0) {
      await rm(this.frameDir, { recursive: true, force: true });
      return null;
    }
    const manifest: CapturedFrameManifest = {
      version: CAPTURED_FRAME_MANIFEST_VERSION,
      format: "jpeg",
      heartbeatMs: FRAME_HEARTBEAT_MS,
      frames: [...this.capturedFrames].sort((a, b) => a.tMs - b.tMs),
    };
    const file = path.join(this.dir, VIDEO_FRAMES_FILE);
    const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
    try {
      await writeFile(temp, JSON.stringify(manifest, null, 2));
      await rename(temp, file);
      return VIDEO_FRAMES_FILE;
    } finally {
      await rm(temp, { force: true });
    }
  }

  private dirFor(file: string): string {
    return this.dir || path.dirname(file);
  }

  private closeStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
    });
  }

  private async teardown(): Promise<void> {
    ipcMain.removeListener("video:chunk", this.onChunk);
    ipcMain.removeListener("video:frame", this.onFrame);
    ipcMain.removeListener("video:frame-error", this.onFrameError);
    ipcMain.removeListener("video:started", this.onStarted);
    ipcMain.removeListener("video:stopped", this.onStopped);
    ipcMain.removeListener("video:error", this.onError);
    this.stoppedResolve = null;
    this.startedResolve = null;
    await this.closeStream();
    this.stream = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private async removeEmptyArtifacts(): Promise<void> {
    if (this.file && existsSync(this.file)) await unlink(this.file).catch(() => undefined);
    if (this.frameDir) await rm(this.frameDir, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validFrameDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 16_384;
}
