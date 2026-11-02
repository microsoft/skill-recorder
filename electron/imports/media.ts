import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { z } from "zod";

import { IMPORT_LIMITS } from "../../common/import";
import type { WindowRequest } from "../frames/extractor";

const directory = path.dirname(fileURLToPath(import.meta.url));
const InfoSchema = z.object({
  durationMs: z.number().positive().max(IMPORT_LIMITS.durationMs),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const FrameSchema = z.object({
  data: z.instanceof(Uint8Array).refine((data) => data.length > 0 && data.length <= 5 * 1024 * 1024),
  offsetMs: z.number().finite().nonnegative(),
});

export class ImportMedia {
  private readonly window: BrowserWindow;
  private cancelRequest: ((error: Error) => void) | null = null;
  private readonly abort: () => void;
  private readonly memoryWatch: ReturnType<typeof setInterval>;

  constructor(private readonly signal: AbortSignal) {
    signal.throwIfAborted();
    this.window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(directory, "imports", "media-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event) => event.preventDefault());
    this.abort = () => this.dispose();
    signal.addEventListener("abort", this.abort, { once: true });
    this.window.on("closed", () => this.cancelRequest?.(new Error("Recording import was interrupted.")));
    this.window.webContents.on("render-process-gone", () => this.dispose());
    this.memoryWatch = setInterval(() => {
      if (this.window.isDestroyed()) return;
      const processId = this.window.webContents.getOSProcessId();
      const memory = app.getAppMetrics().find((item) => item.pid === processId)?.memory.workingSetSize;
      if (memory && memory > 2 * 1024 * 1024) {
        this.cancelRequest?.(new Error("This recording needs too much memory to import. Choose a smaller recording."));
        this.dispose();
      }
    }, 500);
  }

  async open(file: string, hasAudio: boolean, checkAudio: boolean) {
    await this.window.loadFile(path.join(directory, "imports", "media.html"));
    return InfoSchema.parse(await this.request("open", {
      file, hasAudio, checkAudio,
      maxBytes: IMPORT_LIMITS.bytes,
      maxDurationMs: IMPORT_LIMITS.durationMs,
      maxPixels: IMPORT_LIMITS.pixels,
    }));
  }

  async frame(offsetMs: number, crop?: WindowRequest["crop"]) {
    return FrameSchema.parse(await this.request("frame", { offsetMs, crop }));
  }

  private request(action: string, input: object): Promise<unknown> {
    this.signal.throwIfAborted();
    if (this.window.isDestroyed()) throw new Error("Recording media window is closed.");
    if (this.cancelRequest) throw new Error("A recording media request is already in progress.");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timeout);
        ipcMain.removeListener("import:media-result", listener);
        this.cancelRequest = null;
        if (error) reject(error); else resolve(value);
      };
      const listener = (event: IpcMainEvent, requestId: string, response: unknown) => {
        if (this.window.isDestroyed() || event.sender !== this.window.webContents || requestId !== id) return;
        const parsed = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }).safeParse(response);
        if (!parsed.success) finish(new Error("Invalid recording media response."));
        else if (!parsed.data.ok) finish(new Error(parsed.data.error ?? "Recording decode failed."));
        else finish(undefined, parsed.data.result);
      };
      const timeout = setTimeout(() => {
        finish(new Error("Recording media processing timed out."));
        this.dispose();
      }, 120_000);
      this.cancelRequest = (error) => finish(error);
      ipcMain.on("import:media-result", listener);
      this.window.webContents.send("import:media-request", { id, action, input });
    });
  }

  dispose(): void {
    clearInterval(this.memoryWatch);
    this.signal.removeEventListener("abort", this.abort);
    this.cancelRequest?.(new Error("Recording import canceled."));
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
