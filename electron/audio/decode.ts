import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = 256 * 1024;
const MAX_SAMPLES = 256 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 10 * 60_000;

/** Decode and downmix a WebM narration file through Chromium's built-in codecs. */
export async function decodeAudioFile(audioPath: string, signal?: AbortSignal): Promise<Float32Array> {
  signal?.throwIfAborted();
  const id = randomUUID();
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(dirname, "audio", "capture-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  let samples: Float32Array | null = null;
  let received = 0;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let removeListeners = () => undefined;
  const abort = () => { if (!win.isDestroyed()) win.destroy(); };
  signal?.addEventListener("abort", abort, { once: true });

  const result = new Promise<Float32Array>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else if (!samples || received < samples.length) {
        reject(new Error(`Audio decoder returned ${received} of ${samples?.length ?? 0} samples.`));
      } else {
        resolve(samples);
      }
    };

    const owns = (event: IpcMainEvent, jobId: string) =>
      event.sender === win.webContents && jobId === id;

    const onMeta = (event: IpcMainEvent, jobId: string, length: number) => {
      if (!owns(event, jobId)) return;
      if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_SAMPLES) {
        finish(new Error(`Decoded narration length is invalid: ${length}.`));
        return;
      }
      samples = new Float32Array(length);
    };
    const onChunk = (
      event: IpcMainEvent,
      jobId: string,
      offset: number,
      chunk: Float32Array,
    ) => {
      if (!owns(event, jobId) || !samples || !(chunk instanceof Float32Array)) return;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + chunk.length > samples.length) {
        finish(new Error("Audio decoder returned an out-of-range sample chunk."));
        return;
      }
      samples.set(chunk, offset);
      received += chunk.length;
    };
    const onDone = (event: IpcMainEvent, jobId: string) => {
      if (owns(event, jobId)) finish();
    };
    const onError = (event: IpcMainEvent, jobId: string, error: string) => {
      if (owns(event, jobId)) finish(new Error(error || "Chromium audio decode failed."));
    };

    ipcMain.on("audio:decode-meta", onMeta);
    ipcMain.on("audio:decode-chunk", onChunk);
    ipcMain.on("audio:decode-done", onDone);
    ipcMain.on("audio:decode-error", onError);
    win.once("closed", () => finish(new Error("Audio decoder window closed unexpectedly.")));
    removeListeners = () => {
      ipcMain.removeListener("audio:decode-meta", onMeta);
      ipcMain.removeListener("audio:decode-chunk", onChunk);
      ipcMain.removeListener("audio:decode-done", onDone);
      ipcMain.removeListener("audio:decode-error", onError);
    };

    timeout = setTimeout(
      () => finish(new Error("Narration audio decode timed out.")),
      DECODE_TIMEOUT_MS,
    );

    void win
      .loadFile(path.join(dirname, "audio", "capture.html"))
      .then(() => {
        win.webContents.send("audio:decode", {
          id,
          audioPath,
          sampleRate: SAMPLE_RATE,
          chunkSamples: CHUNK_SAMPLES,
        });
      })
      .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });

  try {
    return await result;
  } finally {
    signal?.removeEventListener("abort", abort);
    removeListeners();
    if (!win.isDestroyed()) win.destroy();
  }
}
