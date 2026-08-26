import assert from "node:assert/strict";
import test from "node:test";

import type { Ocr, OcrWord } from "./ocr";
import { OcrFrameRedactor, sensitiveFrameBoxes } from "./frame-redact";

/** Minimal Ocr-shaped stub whose recognize behaviour we control (no tesseract). */
function stubOcr(recognize: (image: string | Buffer) => Promise<OcrWord[]>): Ocr {
  return { recognize } as unknown as Ocr;
}

const word = (text: string, x0: number): OcrWord => ({
  text,
  confidence: 90,
  bbox: { x0, y0: 10, x1: x0 + 80, y1: 40 },
});

test("frame is withheld (null) when OCR recognition throws", async () => {
  // Regression guard: a runtime OCR failure must NOT be treated as "blank screen"
  // (which would serve the frame unblurred). recognize throws → redactFrame → null.
  const redactor = new OcrFrameRedactor({
    ocr: stubOcr(async () => {
      throw new Error("worker crashed");
    }),
    knownValues: [],
  });
  assert.equal(await redactor.redactFrame("/frames/whatever.jpg"), null);
  // Cached result is also the safe null (no second recognition attempt).
  assert.equal(await redactor.redactFrame("/frames/whatever.jpg"), null);
});

test("sensitiveFrameBoxes flags only the OCR words overlapping a secret", async () => {
  const words = [
    word("build", 0),
    word("token", 90),
    word("ghp_abcdefghij0123456789ABCDEFGHIJKLMNPQ", 180),
    word("done", 400),
  ];
  const boxes = await sensitiveFrameBoxes(words, { width: 600, height: 60 });
  assert.equal(boxes.length, 1);
  // The box covers the token word's region (x0=180), not the clean words.
  assert.ok(boxes[0].left <= 180 && boxes[0].left + boxes[0].width >= 200);
});

test("sensitiveFrameBoxes returns nothing for a clean frame", async () => {
  const words = [word("Public", 0), word("roadmap", 90), word("notes", 180)];
  assert.deepEqual(await sensitiveFrameBoxes(words, { width: 400, height: 60 }), []);
});
