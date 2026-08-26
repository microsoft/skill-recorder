// OPT-IN degraded-frame OCR redaction eval (NOT part of the hermetic run).
//
// This is the eval the older ocr-images harness should have been. It renders
// realistic app surfaces (spreadsheet, billing form, terminal, code editor) and
// pushes each through the REAL capture degradation — downscale to a ~1108px JPEG
// (see fixtures/degrade.ts) — before running the REAL `Ocr` engine + the shared
// `sensitiveFrameBoxes`. It then scores whether every sensitive region got a blur
// box (region-overlap recall, per entity type, F2, over-blur), the way a
// locate-and-blur safety net should be measured. Known OCR gaps are marked `xfail`.
//
// Like ocr-images it is non-hermetic (needs the tesseract WASM core, `sharp` with
// system fonts, and a one-time traineddata download) and SELF-SKIPS (exit 0) when
// the environment can't support it, rather than failing.
//
// Run:
//   npm run eval:sensitive:realistic            # render → degrade → real Tesseract
//   npm run eval:sensitive:realistic -- --keep  # also print OCR text + box counts
//   npm run eval:sensitive:realistic -- --write  # dump degraded JPEGs to evals/.cache
//   npm run eval:sensitive:realistic -- --only=billing-form

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Ocr, tessdataFileName } from "../../electron/sensitive/ocr";
import { sensitiveFrameBoxes } from "../../electron/sensitive/frame-redact";
import { renderDegradedFrame } from "./fixtures/degrade";
import { realisticFixtures, type RealisticFixture, type SharpModule } from "./fixtures/templates";
import { aggregate, scoreFixture, type FixtureScore } from "./realistic-score";

const require = createRequire(import.meta.url);
const TESSDATA_BASE = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185";
const CACHE_DIR = path.join(process.cwd(), "evals", ".cache", "tessdata");
const DUMP_DIR = path.join(process.cwd(), "evals", ".cache", "realistic");

// Gates (see the research synthesis): recall is the privacy-critical number.
const RECALL_GATE = 0.95;       // hard: below this, sensitive detail is leaking
const PER_TYPE_GATE = 0.9;      // hard, for types with enough cases to be meaningful
const PER_TYPE_MIN_CASES = 5;
const OVER_BLUR_WARN = 0.1;     // soft: warn if we blur too much clean content
const F2_TARGET = 0.85;         // logged

interface Flags {
  keep: boolean;
  write: boolean;
  only: Set<string> | null;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { keep: false, write: false, only: null };
  for (const arg of argv) {
    if (arg === "--keep") flags.keep = true;
    else if (arg === "--write") flags.write = true;
    else if (arg.startsWith("--only=")) flags.only = new Set(arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
  }
  return flags;
}

function loadSharp(): SharpModule | null {
  try {
    return require("sharp") as SharpModule;
  } catch {
    return null;
  }
}

async function ensureTraineddata(code: string): Promise<boolean> {
  const dest = path.join(CACHE_DIR, tessdataFileName(code));
  if (existsSync(dest)) return true;
  await mkdir(CACHE_DIR, { recursive: true });
  try {
    const res = await fetch(`${TESSDATA_BASE}/${tessdataFileName(code)}`);
    if (!res.ok) return false;
    const tmp = `${dest}.tmp.${process.pid}`;
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await rename(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

let ocrPool: Ocr | null = null;
function pool(): Ocr {
  return (ocrPool ??= new Ocr({ langPath: CACHE_DIR, poolSize: 2 }));
}

/** Probe render+OCR of a known string; false if the environment can't OCR. */
async function environmentUsable(sharp: SharpModule): Promise<boolean> {
  if (!(await ensureTraineddata("eng"))) return false;
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><rect width="600" height="120" fill="#fff"/><text x="20" y="70" font-family="sans-serif" font-size="40" fill="#000">Probe 12345</text></svg>`;
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
    const words = await pool().recognize(buf);
    return /12345/.test(words.map((w) => w.text).join(" "));
  } catch {
    return false;
  }
}

interface EvalResult {
  score: FixtureScore;
  ocrText?: string;
}

async function runFixture(sharp: SharpModule, fixture: RealisticFixture, keep: boolean, write: boolean): Promise<EvalResult> {
  const frame = await renderDegradedFrame(sharp, fixture.svg, fixture.hiResWidth);
  if (write) {
    await mkdir(DUMP_DIR, { recursive: true });
    await writeFile(path.join(DUMP_DIR, `${fixture.id}.jpg`), frame.jpeg);
  }
  const words = await pool().recognize(frame.jpeg);
  const boxes = await sensitiveFrameBoxes(words, {
    width: frame.width,
    height: frame.height,
    knownValues: fixture.knownValues,
  });
  const score = scoreFixture(fixture.id, fixture.about, fixture.regions, boxes, frame.scale);
  return { score, ocrText: keep ? words.map((w) => w.text).join(" ") : undefined };
}

const bar = "─".repeat(72);
const pct = (n: number, d: number): string => (d ? `${(100 * (n / d)).toFixed(0)}%` : "  —");

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.error(`\nSkill Recorder — realistic degraded-frame OCR redaction eval (opt-in, non-hermetic)`);

  const sharp = loadSharp();
  if (!sharp) {
    console.error("  SKIP: sharp is not available; cannot render eval images.\n");
    process.exit(0);
  }
  if (!(await environmentUsable(sharp))) {
    console.error("  SKIP: OCR could not read a probe image (missing fonts, WASM core, or traineddata download).\n");
    await pool().terminate().catch(() => {});
    process.exit(0);
  }

  const fixtures = realisticFixtures.filter((f) => !flags.only || flags.only.has(f.id));
  if (fixtures.length === 0) {
    console.error("  No fixtures matched", flags.only ? [...flags.only] : "");
    await pool().terminate().catch(() => {});
    process.exit(2);
  }

  const results: EvalResult[] = [];
  for (const f of fixtures) results.push(await runFixture(sharp, f, flags.keep, flags.write));
  await pool().terminate().catch(() => {});

  console.error(bar);
  for (const { score, ocrText } of results) {
    const leaks = score.leaks.length;
    const tag = leaks ? "FAIL" : "PASS";
    console.error(`\n  ${tag}  ${score.id} — ${score.about}`);
    console.error(`        ${score.boxCount} blur box(es)`);
    for (const r of score.regions) {
      if (r.outcome === "fn") console.error(`        ✗ LEAK  [${r.entityType}] ${r.text}`);
      else if (r.outcome === "over-blur") console.error(`        ~ over-blur (clean): ${r.text}`);
      else if (r.outcome === "xfail") console.error(`        · xfail  [${r.entityType}] ${r.text} (known gap)`);
      else if (r.outcome === "xpass") console.error(`        ✓ xpass  [${r.entityType}] ${r.text} (known gap now caught)`);
    }
    if (ocrText) console.error(`        OCR: ${ocrText.slice(0, 400)}`);
  }

  const totals = aggregate(results.map((r) => r.score));

  console.error(`\n${bar}\nSummary`);
  console.error(`  recall (sensitive regions blurred):  ${totals.tp}/${totals.tp + totals.fn}  ${pct(totals.tp, totals.tp + totals.fn)}`);
  console.error(`  over-blur (clean regions covered):   ${totals.overBlur}/${totals.cleanTotal}  ${pct(totals.overBlur, totals.cleanTotal)}`);
  console.error(`  F2 (β=2, recall-weighted):           ${totals.f2.toFixed(3)}`);
  if (totals.xfail || totals.xpass) console.error(`  known gaps:                          ${totals.xfail} xfail · ${totals.xpass} xpass`);
  console.error(`\n  per entity type:`);
  for (const [type, b] of Object.entries(totals.perType).sort()) {
    const gated = b.total >= PER_TYPE_MIN_CASES ? " (gated)" : "";
    console.error(`    ${type.padEnd(12)} ${b.covered}/${b.total}  ${pct(b.covered, b.total)}${gated}`);
  }

  // Gates.
  const failures: string[] = [];
  if (totals.recall < RECALL_GATE) failures.push(`overall recall ${pct(totals.tp, totals.tp + totals.fn)} < gate ${RECALL_GATE * 100}%`);
  for (const [type, b] of Object.entries(totals.perType)) {
    if (b.total >= PER_TYPE_MIN_CASES && b.covered / b.total < PER_TYPE_GATE) {
      failures.push(`per-type recall ${type} ${pct(b.covered, b.total)} < gate ${PER_TYPE_GATE * 100}%`);
    }
  }

  console.error("");
  if (totals.overBlurRate > OVER_BLUR_WARN) console.error(`  ⚠ WARN: over-blur rate ${pct(totals.overBlur, totals.cleanTotal)} > ${OVER_BLUR_WARN * 100}%`);
  if (totals.f2 < F2_TARGET) console.error(`  ⚠ NOTE: F2 ${totals.f2.toFixed(3)} < target ${F2_TARGET}`);

  if (failures.length) {
    console.error(`\n  ✗ GATE FAILED:`);
    for (const f of failures) console.error(`      - ${f}`);
    console.error("");
    process.exit(1);
  }
  console.error(`\n  ✓ all gates passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Realistic OCR harness crashed:", err);
  process.exit(3);
});
