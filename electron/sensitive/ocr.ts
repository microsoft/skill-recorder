// On-device OCR for the Advanced protection layer. Wraps tesseract.js v7
// (Apache-2.0) behind a small worker pool. Used only to LOCATE text regions in
// screen frames so they can be blurred before a JPEG leaves the machine — the OCR
// text itself is never sent to the model. Fully offline: the WASM core ships in
// the tesseract.js-core node_module and the language data is a local file the
// model manager downloads once into the app's models dir.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { app } from "electron";

import { createLogger } from "../logger";
import { tessdataFileName } from "./tessdata-source";

export { tessdataFileName };

const require = createRequire(import.meta.url);
const log = createLogger("Sensitive/ocr");

type SharpModule = (typeof import("sharp"))["default"];
let sharpMod: SharpModule | null | undefined;
function sharp(): SharpModule | null {
  if (sharpMod === undefined) {
    try {
      sharpMod = require("sharp") as SharpModule;
    } catch (err) {
      log.warn("sharp unavailable; OCR preprocessing disabled:", err instanceof Error ? err.message : err);
      sharpMod = null;
    }
  }
  return sharpMod;
}

// Captured screen frames are heavily downscaled (~1100px wide), which turns small
// UI / spreadsheet text into OCR garbage — the detectors then match nothing and
// sensitive regions would ship unblurred. Before recognizing, we upscale, drop to
// grayscale, and stretch contrast so small text becomes legible to Tesseract. The
// box coordinates are divided back down by the applied scale so callers still get
// boxes in the SOURCE image's pixel space. Width is capped so a large display can't
// blow up OCR cost.
//
// 3× was chosen by A/B'ing config candidates through the realistic degraded-frame
// eval (evals/sensitive/ocr-realistic.ts). Dictionary-disable, user_defined_dpi,
// PSM 11 and inversion all moved nothing. 4× is NOT a free win: it lets one extra
// borderline token (a 20-char AWS key) land on-pattern, but at the same time flips a
// digit in a Visa number so it fails the Luhn check and leaks — trading a common,
// high-value card for a rare vision-only key that captured terminal/clipboard text
// usually cross-feeds anyway. So we stay at 3×; high-entropy secrets that appear
// ONLY on screen are an accepted OCR gap (see the xfail cases in the eval).
const OCR_UPSCALE = 3;
const OCR_MAX_WIDTH = 3600;

/** Upscale + grayscale + contrast-normalise an image for OCR. Returns the processed
 *  buffer and the scale factor applied (so word boxes can be mapped back to source
 *  pixels). Falls back to the original input at scale 1 if sharp is unavailable or
 *  preprocessing fails. */
async function preprocessForOcr(image: string | Buffer): Promise<{ input: string | Buffer; scale: number }> {
  const s = sharp();
  if (!s) return { input: image, scale: 1 };
  try {
    const pipeline = s(image);
    const meta = await pipeline.metadata();
    const width = meta.width ?? 0;
    if (!width) return { input: image, scale: 1 };
    const target = Math.min(width * OCR_UPSCALE, OCR_MAX_WIDTH);
    const scale = target / width;
    if (scale <= 1) return { input: image, scale: 1 };
    const buffer = await pipeline.resize({ width: Math.round(target) }).grayscale().normalise().toBuffer();
    return { input: buffer, scale };
  } catch (err) {
    log.warn("OCR preprocessing failed; using raw image:", err instanceof Error ? err.message : err);
    return { input: image, scale: 1 };
  }
}

/** Where downloaded on-device models live — shared with narration so one dir holds
 *  them all. Overridable via SKILL_RECORDER_MODELS_DIR for tests/CI. */
export function modelsCacheDir(): string {
  const override = process.env.SKILL_RECORDER_MODELS_DIR;
  if (override) return path.resolve(override);
  return path.join(app.getPath("userData"), "models");
}

/** LSTM-only engine — matches the fast LSTM traineddata and skips legacy components. */
const OEM_LSTM_ONLY = 1;

/** One recognized word with its pixel bounding box in the source image. */
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

type TesseractModule = typeof import("tesseract.js");
type TWorker = Awaited<ReturnType<TesseractModule["createWorker"]>>;

interface RawWord {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}
interface RawPage {
  blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ words?: RawWord[] }> }> }> | null;
}

/** Absolute path to the tesseract.js-core package dir (holds the WASM variants).
 *  Resolved from node_modules at runtime like the app's other native deps. */
export function resolveCorePath(): string {
  return path.dirname(require.resolve("tesseract.js-core/package.json"));
}

export interface OcrOptions {
  /** Directory containing the `<code>.traineddata` files (managed by the model manager). */
  langPath: string;
  /** Number of reusable workers. Small by default — a few frames per call. */
  poolSize?: number;
}

/**
 * A reusable pool of tesseract workers. Workers are expensive to create (each
 * loads the WASM core + language data), so they're built once on first use and
 * reused across recognitions. Recognitions beyond the pool size queue until a
 * worker frees up. `recognize` THROWS on engine failure (rather than returning an
 * empty result) so the frame redactor can tell "OCR failed" apart from "blank
 * screen" and withhold the frame instead of serving unblurred pixels; a genuinely
 * text-free image still resolves with an empty word list.
 *
 * Before recognition each image is upscaled + grayscaled + contrast-normalised
 * (see `preprocessForOcr`) because captured frames are downscaled enough that small
 * on-screen text would otherwise OCR to garbage and defeat the blur pass. Word boxes
 * are mapped back to the source image's pixel space before they're returned.
 */
export class Ocr {
  private readonly langPath: string;
  private readonly lang: string;
  private readonly poolSize: number;
  private tesseract: TesseractModule | null = null;
  private workers: TWorker[] = [];
  private idle: TWorker[] = [];
  private readonly waiters: Array<{
    resolve: (worker: TWorker) => void;
    reject: (err: Error) => void;
  }> = [];
  private initPromise: Promise<void> | null = null;
  private terminated = false;

  constructor(opts: OcrOptions) {
    this.langPath = opts.langPath;
    this.lang = "eng";
    this.poolSize = Math.max(1, Math.min(4, opts.poolSize ?? 2));
  }

  /** True once the English tessdata exists and workers can be built. */
  isLanguageDataPresent(): boolean {
    return existsSync(path.join(this.langPath, tessdataFileName(this.lang)));
  }

  /** Eagerly build the worker pool so the first frame isn't slow and readiness is
   *  genuine (surfaces a load failure now rather than at serve time). */
  async warm(): Promise<void> {
    await this.ensureInit();
  }

  private async ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (!this.isLanguageDataPresent()) {
        throw new Error("OCR language data is not available.");
      }
      // Build into a local list and only publish the pool once EVERY worker is up, so
      // a failure partway through doesn't leave half-built workers in the pool for a
      // retry to duplicate (and leak).
      const built: TWorker[] = [];
      try {
        for (let i = 0; i < this.poolSize; i++) built.push(await this.spawnWorker());
      } catch (err) {
        await Promise.all(built.map((w) => w.terminate().catch(() => undefined)));
        throw err;
      }
      if (this.terminated) {
        // terminate() ran while we were building: tear the new set down instead of
        // publishing it, so disabling protection mid-warm can't leave live workers.
        await Promise.all(built.map((w) => w.terminate().catch(() => undefined)));
        throw new Error("OCR engine has been terminated.");
      }
      this.workers.push(...built);
      this.idle.push(...built);
    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  /** Create one fully-configured worker. Extracted as a seam so the pool lifecycle
   *  (build/rollback/terminate) can be unit-tested without the real WASM engine. */
  protected async spawnWorker(): Promise<TWorker> {
    const tesseract = (this.tesseract ??= await import("tesseract.js"));
    const corePath = resolveCorePath();
    const worker = await tesseract.createWorker(this.lang, OEM_LSTM_ONLY, {
      corePath,
      langPath: this.langPath,
      // "none": never touch a write-back cache; always read the local
      // traineddata from langPath. Fully offline, no network fallback.
      cacheMethod: "none",
      gzip: false,
      workerBlobURL: false,
      legacyCore: false,
      legacyLang: false,
    });
    // Treat each frame as one uniform block. On dense screen captures this
    // recovers far more text than the default auto-segmentation (which drops
    // regions it misjudges as non-text), maximizing recall for the blur pass.
    await worker.setParameters({ tessedit_pageseg_mode: tesseract.PSM.SINGLE_BLOCK });
    return worker;
  }

  /** Recognize words + boxes in one image (a JPEG file path or a Buffer). Throws on
   *  engine failure so callers withhold the frame rather than treat a failed read as
   *  "nothing to blur"; a successful read of a text-free image returns []. */
  async recognize(image: string | Buffer): Promise<OcrWord[]> {
    if (this.terminated) throw new Error("OCR engine has been terminated.");
    await this.ensureInit();
    const { input, scale } = await preprocessForOcr(image);
    const worker = await this.acquire();
    try {
      const { data } = await worker.recognize(input, {}, { blocks: true });
      return wordsFrom(data as unknown as RawPage, scale);
    } catch (err) {
      log.warn("recognize failed:", err instanceof Error ? err.message : err);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.release(worker);
    }
  }

  private acquire(): Promise<TWorker> {
    if (this.terminated) return Promise.reject(new Error("OCR engine has been terminated."));
    const worker = this.idle.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise<TWorker>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(worker: TWorker): void {
    // If the pool was torn down while this recognition was in flight, the worker has
    // already been terminated by terminate(); don't resurrect it into the idle set.
    if (this.terminated) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(worker);
    else this.idle.push(worker);
  }

  /** Tear down all workers (called when Advanced protection is disabled / on quit). */
  async terminate(): Promise<void> {
    this.terminated = true;
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    // Fail any queued recognitions right away so they withhold their frame instead of
    // waiting on an in-flight (possibly hung) recognize to hand back a now-dead worker.
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter.reject(new Error("OCR engine has been terminated."));
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
  }
}

/** Flatten a recognition result to non-empty words with boxes. Word boxes are in
 *  the OCR (possibly upscaled) image space; dividing by `scale` maps them back to
 *  the source image's pixel coordinates so callers can blur the original frame. */
function wordsFrom(page: RawPage, scale = 1): OcrWord[] {
  const out: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = (word.text ?? "").trim();
          if (!text || !word.bbox) continue;
          out.push({
            text,
            confidence: typeof word.confidence === "number" ? word.confidence : 0,
            bbox: {
              x0: word.bbox.x0 / scale,
              y0: word.bbox.y0 / scale,
              x1: word.bbox.x1 / scale,
              y1: word.bbox.y1 / scale,
            },
          });
        }
      }
    }
  }
  return out;
}
