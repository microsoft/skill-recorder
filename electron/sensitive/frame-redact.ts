// Frame OCR + blur for the Advanced protection layer. When Advanced
// protection is on, screen frames the describer would send to GitHub Copilot are
// first OCR'd on-device; any word whose text trips the same detectors used for the
// session's text (secrets, structured PII) — or matches a value already detected
// elsewhere in the session — is covered with an opaque box before the JPEG leaves
// the machine. The OCR text itself is never sent; only the blurred image is. Boxes
// are solid and irreversible (safer than a reversible blur).

import { createRequire } from "node:module";

import {
  resolveOverlaps,
  scanStructuredPii,
  type SensitiveMatch,
} from "../../common/sensitive";
import { createLogger } from "../logger";
import { frameSecretMatches } from "./frame-heuristics";
import type { Ocr, OcrWord } from "./ocr";
import { scanSecrets } from "./secrets";

const require = createRequire(import.meta.url);
const log = createLogger("Sensitive/frames");

type Sharp = (typeof import("sharp"))["default"];
let sharpMod: Sharp | null | undefined;
function sharp(): Sharp | null {
  if (sharpMod === undefined) {
    try {
      sharpMod = require("sharp") as Sharp;
    } catch (err) {
      log.warn("sharp unavailable; frame blur disabled:", message(err));
      sharpMod = null;
    }
  }
  return sharpMod;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A pixel box to paint over a sensitive region of a frame. */
export type FrameBox = Rect;

export interface FrameBoxOptions {
  width: number;
  height: number;
  /** Values already detected in the session's text (cross-feed blur). */
  knownValues?: string[];
  /** Padding added around each detected word box, in pixels. */
  padding?: number;
}

/**
 * Map every sensitive region in a set of OCR words to a padded pixel box. Runs the
 * shared detectors (secrets + structured PII) over the recognized text, plus a
 * literal search for known session values, then selects every OCR word whose
 * character span overlaps a match. Pure and side-effect-free (no sharp, no image
 * IO) so it can be exercised deterministically. Returns the boxes to blur.
 */
export async function sensitiveFrameBoxes(words: OcrWord[], opts: FrameBoxOptions): Promise<FrameBox[]> {
  if (words.length === 0) return [];
  const padding = opts.padding ?? 4;
  const knownValues = [...new Set((opts.knownValues ?? []).filter((v) => v.length >= 3))];

  // Join words into one string, remembering each word's char span + box. Tesseract
  // often emits an "@" (or a value split around one) as its own token with spaces on
  // each side, e.g. `jordan.blake @ example.com`; a space next to "@" is never
  // meaningful in the values we detect, so we glue across it to keep emails intact
  // for the detectors. Other separators (spaces in card/phone numbers) are preserved.
  let joined = "";
  const spans: Array<{ start: number; end: number; word: OcrWord }> = [];
  for (const word of words) {
    const glue = joined.endsWith("@") || word.text.startsWith("@");
    if (joined && !glue) joined += " ";
    const start = joined.length;
    joined += word.text;
    spans.push({ start, end: joined.length, word });
  }

  const matches = await matchesInOcrText(joined, knownValues);
  if (matches.length === 0) return [];

  const rects: FrameBox[] = [];
  const seen = new Set<OcrWord>();
  for (const match of matches) {
    for (const span of spans) {
      if (span.start < match.end && match.start < span.end && !seen.has(span.word)) {
        seen.add(span.word);
        rects.push(boxFor(span.word, opts.width, opts.height, padding));
      }
    }
  }
  return rects;
}

/** All detector matches in the recognized text, plus literal known-value hits. */
async function matchesInOcrText(
  text: string,
  knownValues: string[],
): Promise<SensitiveMatch[]> {
  const secrets = await scanSecrets(text);
  const pii = scanStructuredPii(text);
  // Frame-only, reading-independent structural detection: locates secret-shaped
  // regions (high-entropy tokens, credential assignments) even when OCR garbles
  // the exact glyphs, which the fixed-pattern secret detectors above require.
  // Recall-first — see frame-heuristics.ts for the trade-off.
  const structural = frameSecretMatches(text);
  const known: SensitiveMatch[] = [];
  for (const value of knownValues) {
    for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + 1)) {
      known.push({
        category: "password",
        label: "Known sensitive value",
        severity: "high",
        value,
        start: i,
        end: i + value.length,
        rank: 100,
      });
    }
  }
  return resolveOverlaps([...secrets, ...pii, ...structural, ...known]);
}

/** A padded, image-clamped box for one OCR word. */
function boxFor(word: OcrWord, width: number, height: number, padding: number): Rect {
  const x0 = Math.max(0, Math.floor(word.bbox.x0) - padding);
  const y0 = Math.max(0, Math.floor(word.bbox.y0) - padding);
  const x1 = Math.min(width, Math.ceil(word.bbox.x1) + padding);
  const y1 = Math.min(height, Math.ceil(word.bbox.y1) + padding);
  return { left: x0, top: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/**
 * Redacts sensitive regions from screen frames before they're sent. The get_frames
 * tool uses the flags to decide policy:
 *   - `active` false → Advanced protection is off; serve raw frames (baseline).
 *   - `active` true, `ready` false → assets still loading; WITHHOLD frames.
 *   - `active` true, `ready` true → blur detected regions per frame.
 */
export interface FrameRedactor {
  /** Advanced protection is on for this run (frames must be protected). */
  readonly active: boolean;
  /** OCR is available; when false while `active`, the caller withholds frames. */
  readonly ready: boolean;
  /** Running tally of what was blurred across this analyze run, for the review
   *  summary. Counts each source frame once (repeat requests are cached). */
  readonly stats: FrameRedactionStats;
  /** Produce a protected JPEG for a source frame, or null on failure (the caller
   *  then withholds that frame rather than risk serving raw pixels). */
  redactFrame(sourceFramePath: string): Promise<Buffer | null>;
}

/** How many screen images were blurred, and how many on-screen regions in them. */
export interface FrameRedactionStats {
  /** Distinct source frames in which at least one region was covered. */
  framesBlurred: number;
  /** Total regions (boxes) painted across all frames. */
  regionsBlurred: number;
}

const NO_FRAME_STATS: FrameRedactionStats = Object.freeze({ framesBlurred: 0, regionsBlurred: 0 });

/** A no-op redactor for when Advanced protection is off — frames pass through. */
export const INACTIVE_FRAME_REDACTOR: FrameRedactor = {
  active: false,
  ready: true,
  stats: NO_FRAME_STATS,
  redactFrame: async () => null,
};

/** A fail-safe redactor for when Advanced protection is ON but the scan could not
 *  run (e.g. it threw): `active` with `ready:false` makes get_frames WITHHOLD every
 *  frame rather than serve raw pixels we never got a chance to inspect. */
export const WITHHOLD_FRAME_REDACTOR: FrameRedactor = {
  active: true,
  ready: false,
  stats: NO_FRAME_STATS,
  redactFrame: async () => null,
};

export interface FrameRedactorOptions {
  ocr: Ocr | null;
  /** Values already detected in the session's text (cross-feed blur). */
  knownValues: string[];
  /** Padding added around each detected word box, in pixels. */
  padding?: number;
}

/**
 * OCR-backed frame redactor. Recognizes words + boxes, runs the shared detectors
 * over the recognized text (plus a literal search for known session values), and
 * paints an opaque box over every matched word. Results are cached per source
 * frame path for the lifetime of the redactor (one analyze run).
 */
export class OcrFrameRedactor implements FrameRedactor {
  readonly active = true;
  private readonly ocr: Ocr | null;
  private readonly knownValues: string[];
  private readonly padding: number;
  private readonly cache = new Map<string, Buffer | null>();
  private framesBlurred = 0;
  private regionsBlurred = 0;

  constructor(opts: FrameRedactorOptions) {
    this.ocr = opts.ocr;
    this.knownValues = [...new Set(opts.knownValues.filter((v) => v.length >= 3))];
    this.padding = opts.padding ?? 4;
  }

  get ready(): boolean {
    return this.ocr != null && sharp() != null;
  }

  get stats(): FrameRedactionStats {
    return { framesBlurred: this.framesBlurred, regionsBlurred: this.regionsBlurred };
  }

  async redactFrame(sourceFramePath: string): Promise<Buffer | null> {
    if (!this.ocr) return null;
    const cached = this.cache.get(sourceFramePath);
    if (cached !== undefined) return cached;
    let result: Buffer | null;
    try {
      result = await this.buildRedactedFrame(sourceFramePath);
    } catch (err) {
      log.warn("frame redaction failed:", message(err));
      result = null;
    }
    this.cache.set(sourceFramePath, result);
    return result;
  }

  private async buildRedactedFrame(sourceFramePath: string): Promise<Buffer | null> {
    const s = sharp();
    if (!s || !this.ocr) return null;

    // Throws on OCR engine failure → caught by redactFrame → the frame is withheld
    // (never served unblurred). A text-free frame resolves to [] and serves normally.
    const words = await this.ocr.recognize(sourceFramePath);
    const image = s(sourceFramePath);
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;

    const boxes = await sensitiveFrameBoxes(words, {
      width,
      height,
      knownValues: this.knownValues,
      padding: this.padding,
    });
    if (boxes.length === 0) {
      // Nothing sensitive on screen — re-encode so callers uniformly serve the
      // redactor's output (and never accidentally serve the raw file bytes).
      return image.jpeg({ quality: 85 }).toBuffer();
    }

    // Count once per distinct source frame (redactFrame caches, so buildRedactedFrame
    // only runs on the first request for a given path).
    this.framesBlurred += 1;
    this.regionsBlurred += boxes.length;

    const overlays = boxes.map((box) => ({
      input: {
        create: {
          width: box.width,
          height: box.height,
          channels: 3 as const,
          background: { r: 17, g: 17, b: 17 },
        },
      },
      left: box.left,
      top: box.top,
    }));
    return image.composite(overlays).jpeg({ quality: 85 }).toBuffer();
  }
}
