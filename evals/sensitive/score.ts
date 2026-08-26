// Deterministic, LLM-free scoring for the sensitive-detail evals.
//
// Runs the SAME detection layers the Analyze pipeline uses — secretlint (secrets)
// and our in-repo structured-PII regex — then applies the real text redactor. A
// case passes only when BOTH hold:
//   - recall: every `mustRedact` value is gone from the redacted text, and
//   - precision: every `mustKeep` value survives, and clean cases yield no findings.
// This exercises detection and redaction end to end: a raw value that is detected
// but not masked (or masked but re-detectable) fails just like a miss.

import {
  redactText,
  resolveOverlaps,
  scanStructuredPii,
  type SensitiveMatch,
} from "../../common/sensitive";
import { scanSecrets } from "../../electron/sensitive/secrets";
import { sensitiveFrameBoxes, type FrameBox } from "../../electron/sensitive/frame-redact";
import type { OcrWord } from "../../electron/sensitive/ocr";
import type { SensitiveCase } from "./corpus";
import type { FrameCase } from "./frames";

export interface Check {
  name: string;
  kind: "recall" | "precision";
  pass: boolean;
  detail?: string;
}

export interface CaseScore {
  id: string;
  about: string;
  pass: boolean;
  score: number;
  matchCount: number;
  redacted: string;
  checks: Check[];
}

/** All detection layers merged and de-overlapped, exactly as the scanner does. */
export async function detect(text: string): Promise<SensitiveMatch[]> {
  const secrets = await scanSecrets(text);
  const pii = scanStructuredPii(text);
  return resolveOverlaps([...secrets, ...pii]);
}

const short = (s: string): string => (s.length <= 24 ? s : `${s.slice(0, 10)}…${s.slice(-6)}`);

export async function scoreCase(c: SensitiveCase): Promise<CaseScore> {
  const matches = await detect(c.text);
  const redacted = redactText(c.text, matches);
  const checks: Check[] = [];

  for (const value of c.mustRedact) {
    const gone = !redacted.includes(value);
    checks.push({
      name: `redacts ${short(value)}`,
      kind: "recall",
      pass: gone,
      detail: gone ? undefined : "raw value still present after redaction",
    });
  }

  for (const keep of c.mustKeep) {
    const kept = redacted.includes(keep);
    checks.push({
      name: `keeps ${short(keep)}`,
      kind: "precision",
      pass: kept,
      detail: kept ? undefined : "expected-clean text was masked (over-redaction)",
    });
  }

  if (c.mustRedact.length === 0) {
    checks.push({
      name: "no findings on clean text",
      kind: "precision",
      pass: matches.length === 0,
      detail: matches.length === 0 ? undefined : `flagged ${matches.length} span(s)`,
    });
  }

  const passed = checks.filter((c) => c.pass).length;
  return {
    id: c.id,
    about: c.about,
    pass: passed === checks.length,
    score: checks.length ? passed / checks.length : 1,
    matchCount: matches.length,
    redacted,
    checks,
  };
}

export interface Totals {
  recallPass: number;
  recallTotal: number;
  precisionPass: number;
  precisionTotal: number;
}

export function tally(scores: CaseScore[]): Totals {
  const totals: Totals = { recallPass: 0, recallTotal: 0, precisionPass: 0, precisionTotal: 0 };
  for (const s of scores) {
    for (const check of s.checks) {
      if (check.kind === "recall") {
        totals.recallTotal += 1;
        if (check.pass) totals.recallPass += 1;
      } else {
        totals.precisionTotal += 1;
        if (check.pass) totals.precisionPass += 1;
      }
    }
  }
  return totals;
}

/* --- Frame OCR + blur scoring ---------------------------------------------- */

const ROW_TOP = 10;
const ROW_BOTTOM = 40;
const WORD_WIDTH = 100;
const WORD_STRIDE = 160; // wide gap so a padded box only overlaps its own word

interface PlacedWord {
  ocr: OcrWord;
  sensitive: boolean;
}

/** Lay frame words out left-to-right on one row with wide gaps between them. */
function placeWords(frame: FrameCase): { words: PlacedWord[]; width: number; height: number } {
  const words = frame.words.map((w, i) => {
    const x0 = 10 + i * WORD_STRIDE;
    return {
      ocr: { text: w.text, confidence: 95, bbox: { x0, y0: ROW_TOP, x1: x0 + WORD_WIDTH, y1: ROW_BOTTOM } },
      sensitive: Boolean(w.sensitive),
    };
  });
  const width = 20 + frame.words.length * WORD_STRIDE;
  return { words, height: 60, width };
}

/** True when a returned blur box overlaps a word's original bounding box. */
function overlaps(box: FrameBox, word: OcrWord): boolean {
  return (
    box.left < word.bbox.x1 &&
    word.bbox.x0 < box.left + box.width &&
    box.top < word.bbox.y1 &&
    word.bbox.y0 < box.top + box.height
  );
}

export async function scoreFrameCase(frame: FrameCase): Promise<CaseScore> {
  const { words, width, height } = placeWords(frame);
  const boxes = await sensitiveFrameBoxes(
    words.map((w) => w.ocr),
    {
      width,
      height,
      knownValues: frame.knownValues ?? [],
    },
  );

  const checks: Check[] = [];
  for (const placed of words) {
    const blurred = boxes.some((b) => overlaps(b, placed.ocr));
    if (placed.sensitive) {
      checks.push({
        name: `blurs "${placed.ocr.text}"`,
        kind: "recall",
        pass: blurred,
        detail: blurred ? undefined : "sensitive word left visible",
      });
    } else {
      checks.push({
        name: `keeps "${placed.ocr.text}" visible`,
        kind: "precision",
        pass: !blurred,
        detail: blurred ? "ordinary word was blurred (over-redaction)" : undefined,
      });
    }
  }

  const passed = checks.filter((c) => c.pass).length;
  const blurredCount = words.filter((w) => boxes.some((b) => overlaps(b, w.ocr))).length;
  return {
    id: frame.id,
    about: frame.about,
    pass: passed === checks.length,
    score: checks.length ? passed / checks.length : 1,
    matchCount: boxes.length,
    redacted: `blurred ${blurredCount}/${words.length} word(s)`,
    checks,
  };
}
