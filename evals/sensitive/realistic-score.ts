// Metrics for the degraded-frame OCR eval. The right question for a locate-and-blur
// safety net is NOT "did OCR transcribe the text correctly?" (CER/WER) but "did a
// blur box actually land over the sensitive region?" — a garbled-but-covered value
// is still safe, while a perfectly-transcribed-but-uncovered one leaks. So scoring
// is region-overlap based:
//   - recall (primary): fraction of sensitive regions covered by some blur box.
//   - per-entity-type recall: the same, split by detail type, to catch a regression
//     that only hurts one type (e.g. cards) while overall recall still looks fine.
//   - over-blur rate: fraction of clean regions a box covered (precision proxy).
//   - F2 (β=2): recall-weighted harmonic mean, matching Presidio's redaction default.
// Known, accepted gaps are marked `xfail` on the fixture region: a miss there is
// reported but does NOT count against the recall gate (an unexpected catch is XPASS).

import type { FrameBox } from "../../electron/sensitive/frame-redact";
import { scaleBox, type GtRect } from "./fixtures/degrade";
import type { EntityType, FixtureRegion } from "./fixtures/templates";

/** A clean region counts as over-blurred only when a box covers a meaningful share
 *  of it — small padding bleed from an adjacent sensitive box shouldn't be a "fail". */
const OVER_BLUR_MIN_FRACTION = 0.3;

export type RegionOutcome = "tp" | "fn" | "xfail" | "xpass" | "clean-ok" | "over-blur";

export interface ScoredRegion {
  text: string;
  entityType?: EntityType;
  sensitive: boolean;
  outcome: RegionOutcome;
}

export interface FixtureScore {
  id: string;
  about: string;
  boxCount: number;
  regions: ScoredRegion[];
  /** Leaked sensitive values (FN, non-xfail) — the privacy-critical failures. */
  leaks: string[];
}

function boxRect(b: FrameBox): GtRect {
  return { x0: b.left, y0: b.top, x1: b.left + b.width, y1: b.top + b.height };
}

function intersectionArea(a: GtRect, b: GtRect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

function area(r: GtRect): number {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

/** Score one fixture's regions against the blur boxes the real pipeline produced.
 *  `regions` are in hi-res template space; `scale` maps them into the capture space
 *  the boxes live in. */
export function scoreFixture(
  id: string,
  about: string,
  regions: FixtureRegion[],
  boxes: FrameBox[],
  scale: number,
): FixtureScore {
  const boxRects = boxes.map(boxRect);
  const scored: ScoredRegion[] = [];
  const leaks: string[] = [];

  for (const region of regions) {
    const rect = scaleBox(region.rect, scale);
    if (region.sensitive) {
      const covered = boxRects.some((b) => intersectionArea(b, rect) > 0);
      let outcome: RegionOutcome;
      if (region.xfail) outcome = covered ? "xpass" : "xfail";
      else {
        outcome = covered ? "tp" : "fn";
        if (!covered) leaks.push(region.text);
      }
      scored.push({ text: region.text, entityType: region.entityType, sensitive: true, outcome });
    } else {
      const a = area(rect);
      const covered = a > 0 && boxRects.some((b) => intersectionArea(b, rect) >= OVER_BLUR_MIN_FRACTION * a);
      scored.push({ text: region.text, sensitive: false, outcome: covered ? "over-blur" : "clean-ok" });
    }
  }

  return { id, about, boxCount: boxes.length, regions: scored, leaks };
}

export interface TypeTotals {
  covered: number;
  total: number;
}

export interface RealisticTotals {
  tp: number;
  fn: number;
  overBlur: number;
  cleanTotal: number;
  xfail: number;
  xpass: number;
  perType: Record<string, TypeTotals>;
  recall: number;
  overBlurRate: number;
  precision: number;
  f2: number;
}

export function aggregate(scores: FixtureScore[]): RealisticTotals {
  const t: RealisticTotals = {
    tp: 0, fn: 0, overBlur: 0, cleanTotal: 0, xfail: 0, xpass: 0,
    perType: {}, recall: 1, overBlurRate: 0, precision: 1, f2: 1,
  };
  for (const s of scores) {
    for (const r of s.regions) {
      if (r.sensitive) {
        if (r.outcome === "xfail") t.xfail += 1;
        else if (r.outcome === "xpass") t.xpass += 1;
        else {
          const type = r.entityType ?? "unknown";
          const bucket = (t.perType[type] ??= { covered: 0, total: 0 });
          bucket.total += 1;
          if (r.outcome === "tp") { t.tp += 1; bucket.covered += 1; } else t.fn += 1;
        }
      } else {
        t.cleanTotal += 1;
        if (r.outcome === "over-blur") t.overBlur += 1;
      }
    }
  }
  const sensitive = t.tp + t.fn;
  t.recall = sensitive ? t.tp / sensitive : 1;
  t.overBlurRate = t.cleanTotal ? t.overBlur / t.cleanTotal : 0;
  t.precision = t.tp + t.overBlur ? t.tp / (t.tp + t.overBlur) : 1;
  t.f2 = t.precision + t.recall ? (5 * t.precision * t.recall) / (4 * t.precision + t.recall) : 0;
  return t;
}

export function f2(precision: number, recall: number): number {
  return precision + recall ? (5 * precision * recall) / (4 * precision + recall) : 0;
}
