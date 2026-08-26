// OPT-IN real-image OCR eval (NOT part of the hermetic `eval:sensitive` run).
//
// The default sensitive frame eval feeds SYNTHETIC OCR words to the box mapper, so
// it can't catch the real leak vector: Tesseract misreading on-screen text badly
// enough that a secret/PII value is never detected (and the frame ships unblurred).
// This harness closes that gap end-to-end: it renders text to actual JPEGs, runs
// the REAL `Ocr` engine + the shared detectors via `sensitiveFrameBoxes`, and checks
// that every sensitive line gets a blur box while clean lines are left alone.
//
// It is non-hermetic (needs the tesseract WASM core, `sharp` with system fonts, and
// a one-time traineddata download per language), so it lives behind its own script
// and SELF-SKIPS (exit 0) when the environment can't support it rather than failing.
//
// Run:
//   npm run eval:sensitive:ocr            # renders text → JPEG, real Tesseract (English)
//   npm run eval:sensitive:ocr -- --keep  # print each rendered case's OCR text

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Ocr, tessdataFileName, type OcrWord } from "../../electron/sensitive/ocr";
import { sensitiveFrameBoxes, type FrameBox } from "../../electron/sensitive/frame-redact";

const require = createRequire(import.meta.url);
const TESSDATA_BASE = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185";
const CACHE_DIR = path.join(process.cwd(), "evals", ".cache", "tessdata");

// Layout: one row per line, generous line height, so a box's vertical position
// alone tells us which line it covers (robust to Tesseract's horizontal jitter).
const WIDTH = 1000;
const PAD = 34;
const LINE_H = 74;
const FONT = 34;

interface Row {
  text: string;
  /** Sensitive rows MUST get a blur box; clean rows must NOT. */
  sensitive: boolean;
}

interface OcrImageCase {
  id: string;
  about: string;
  rows: Row[];
  /** Session values known from clean text (cross-feed blur). */
  knownValues?: string[];
}

const cases: OcrImageCase[] = [
  {
    id: "eng-secret-token",
    about: "GitHub token on screen amid ordinary log lines (English)",
    rows: [
      { text: "Deployment log for release build", sensitive: false },
      { text: "token ghp_abcdefghij0123456789ABCDEFGHIJKLMNPQ", sensitive: true },
      { text: "Status: completed successfully", sensitive: false },
    ],
  },
  {
    id: "eng-card-and-email",
    about: "Credit card + email on screen (English)",
    rows: [
      { text: "Customer billing record", sensitive: false },
      { text: "Card 4111 1111 1111 1111 exp 09 27", sensitive: true },
      { text: "Contact jordan.blake@example.com", sensitive: true },
      { text: "Notes: follow up next week", sensitive: false },
    ],
  },
  {
    id: "eng-known-crossfeed",
    about: "Codeword known from clean text is blurred wherever it appears (English)",
    knownValues: ["APERTURE"],
    rows: [
      { text: "Project APERTURE kickoff", sensitive: true },
      { text: "Public roadmap discussion", sensitive: false },
    ],
  },
  {
    // The eng-only product decision in action: a Japanese screen with English-only
    // traineddata loaded. The Latin email is ASCII, so eng OCR still reads (and
    // blurs) it even though the surrounding Japanese lines come back as garbage.
    id: "eng-only-email-amid-japanese",
    about: "Latin email amid Japanese text, read with ENGLISH-ONLY traineddata",
    rows: [
      { text: "ログイン情報の確認", sensitive: false },
      { text: "メール: taro.yamada@example.co.jp", sensitive: true },
      { text: "処理が完了しました", sensitive: false },
    ],
  },
];

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface Rendered {
  buffer: Buffer;
  width: number;
  height: number;
  bands: Array<{ top: number; bottom: number }>;
}

type SharpModule = (typeof import("sharp"))["default"];

/** Render rows to a JPEG (black text on white), one row per fixed-height band. */
async function renderRows(sharp: SharpModule, rows: Row[]): Promise<Rendered> {
  const height = PAD * 2 + rows.length * LINE_H;
  const bands = rows.map((_, i) => ({ top: PAD + i * LINE_H, bottom: PAD + (i + 1) * LINE_H }));
  const texts = rows
    .map((row, i) => {
      const y = PAD + i * LINE_H + Math.round((LINE_H + FONT) / 2) - 6;
      return `<text x="${PAD}" y="${y}" font-family="sans-serif" font-size="${FONT}" fill="#000">${escapeXml(row.text)}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"><rect width="${WIDTH}" height="${height}" fill="#fff"/>${texts}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  return { buffer, width: WIDTH, height, bands };
}

function boxOverlapsBand(box: FrameBox, band: { top: number; bottom: number }): boolean {
  return box.top < band.bottom && band.top < box.top + box.height;
}

async function ensureTraineddata(code: string): Promise<boolean> {
  const dest = path.join(CACHE_DIR, tessdataFileName(code));
  if (existsSync(dest)) return true;
  await mkdir(CACHE_DIR, { recursive: true });
  try {
    const res = await fetch(`${TESSDATA_BASE}/${tessdataFileName(code)}`);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${dest}.tmp.${process.pid}`;
    await writeFile(tmp, buf);
    await rename(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

interface CaseResult {
  id: string;
  about: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  ocrText?: string;
}

const ocrPools = new Map<string, Ocr>();

function pool(): Ocr {
  let p = ocrPools.get("eng");
  if (!p) {
    p = new Ocr({ langPath: CACHE_DIR, poolSize: 1 });
    ocrPools.set("eng", p);
  }
  return p;
}

async function scoreCase(sharp: SharpModule, c: OcrImageCase, keep: boolean): Promise<CaseResult> {
  if (!(await ensureTraineddata("eng"))) {
    return { id: c.id, about: c.about, status: "skip", detail: `no traineddata for "eng" (offline?)` };
  }

  let words: OcrWord[];
  const rendered = await renderRows(sharp, c.rows);
  try {
    words = await pool().recognize(rendered.buffer);
  } catch (err) {
    return { id: c.id, about: c.about, status: "skip", detail: `OCR engine unavailable: ${err instanceof Error ? err.message : err}` };
  }
  const ocrText = words.map((w) => w.text).join(" ");

  const boxes = await sensitiveFrameBoxes(words, {
    width: rendered.width,
    height: rendered.height,
    knownValues: c.knownValues,
  });

  const problems: string[] = [];
  rendered.bands.forEach((band, i) => {
    const covered = boxes.some((b) => boxOverlapsBand(b, band));
    const row = c.rows[i];
    if (row.sensitive && !covered) problems.push(`leaked (no blur): "${row.text}"`);
    if (!row.sensitive && covered) problems.push(`over-blur (clean line covered): "${row.text}"`);
  });

  const result: CaseResult = {
    id: c.id,
    about: c.about,
    status: problems.length ? "fail" : "pass",
    detail: problems.length ? problems.join("; ") : `${boxes.length} box(es) over ${c.rows.filter((r) => r.sensitive).length} sensitive line(s)`,
  };
  if (keep) result.ocrText = ocrText;
  return result;
}

/** Probe render+OCR of a known string; returns false if the environment can't OCR. */
async function environmentUsable(sharp: SharpModule): Promise<boolean> {
  if (!(await ensureTraineddata("eng"))) return false;
  try {
    const probe = await renderRows(sharp, [{ text: "Sensitive check 12345", sensitive: false }]);
    const words = await pool().recognize(probe.buffer);
    const text = words.map((w) => w.text).join(" ");
    return /12345/.test(text);
  } catch {
    return false;
  }
}

function loadSharp(): SharpModule | null {
  try {
    return require("sharp") as SharpModule;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  console.error(`\nSkill Recorder — real-image OCR redaction eval (opt-in, non-hermetic)`);

  const sharp = loadSharp();
  if (!sharp) {
    console.error("  SKIP: sharp is not available; cannot render eval images.\n");
    process.exit(0);
  }
  if (!(await environmentUsable(sharp))) {
    console.error("  SKIP: OCR could not read a probe image (missing fonts, WASM core, or traineddata download).\n");
    await Promise.all([...ocrPools.values()].map((p) => p.terminate().catch(() => {})));
    process.exit(0);
  }

  const results: CaseResult[] = [];
  for (const c of cases) results.push(await scoreCase(sharp, c, keep));
  await Promise.all([...ocrPools.values()].map((p) => p.terminate().catch(() => {})));

  console.error("─".repeat(64));
  for (const r of results) {
    const tag = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
    console.error(`  ${tag}  ${r.id} — ${r.about}`);
    console.error(`        ${r.detail}`);
    if (r.ocrText) console.error(`        OCR: ${r.ocrText}`);
  }

  const failed = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "pass").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.error(`\n  ${passed} passed · ${failed.length} failed · ${skipped} skipped (of ${results.length})\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("OCR image harness crashed:", err);
  process.exit(3);
});
