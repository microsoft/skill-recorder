import assert from "node:assert/strict";
import test from "node:test";

import {
  frameSecretMatches,
  looksLikeHighEntropySecret,
  shannonEntropy,
} from "./frame-heuristics";

/** True when some emitted match's value contains `needle` (ignoring whitespace). */
function caught(text: string, needle: string): boolean {
  const strip = (s: string) => s.replace(/\s+/g, "");
  return frameSecretMatches(text).some((m) => strip(m.value).includes(strip(needle)));
}

test("catches a GitHub token even when OCR garbled the tail", () => {
  // The exact glyphs are wrong (OCR), but the long high-entropy run is
  // unmistakable — caught by shape alone, no `ghp_` prefix rule needed.
  const ocr = "export GITHUB TOKEN=ghp_la2B3c4D5e6F7g8H910U1k2L3m4N506P7qg8R";
  assert.ok(caught(ocr, "ghp_la2B3c4D5e6F7g8H910U1k2L3m4N506P7qg8R"));
});

test("catches an AWS access key id by shape (length + entropy, no prefix rule)", () => {
  assert.ok(caught("AWS _ACCESS KEY ID=AKIA5SXYO7WZ3PLMN8RTV", "AKIA5SXYO7WZ3PLMN8RTV"));
});

test("catches a Stripe key whose token OCR split off with a space", () => {
  // `sk_live` lost its underscore to a space; there is no prefix rule anyway —
  // the long high-entropy tail is what gets caught, reading-independently.
  const ocr = "stripe _secret_key: sk_live 4eC39HgqLyjWDarjtTizdp7dcABCDEFGH1234";
  assert.ok(caught(ocr, "4eC39HgqLyjWDarjtTizdp7dcABCDEFGH1234"));
});

test("catches a JWT by shape (one long high-entropy token)", () => {
  const jwt = "eyJhbGci0iJIUzIINilsInRScCI61lkpxvCcJ9.eyJzdWlidilxMjJMONSIsIm5S.dozjgNryP4J3jVmNHLOWSNXgl";
  assert.ok(caught(`session jwt: ${jwt}`, "eyJhbGci0iJIUzIINilsInRScCI61lkpxvCcJ9"));
});

test("catches a credential assignment with a short-but-secret value", () => {
  // Too short / low-entropy for the token rule, but the `password:` context makes
  // it a clear secret.
  assert.ok(caught("db password: hunter2Summer", "hunter2Summer"));
  assert.ok(caught("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIbPxRfiCYEXAMPLE", "wJalrXUtnFEMIbPxRfiCYEXAMPLE"));
});

test("does not flag ordinary prose", () => {
  assert.deepEqual(frameSecretMatches("the quick brown fox jumps over the lazy dog today"), []);
});

test("does not flag a URL or a file path", () => {
  assert.deepEqual(frameSecretMatches("see https://example.com/docs/getting-started/setup"), []);
  assert.deepEqual(frameSecretMatches("open src/components/Recorder/index.tsx now"), []);
});

test("does not flag a bare card/phone/digit run (owned by the PII detectors)", () => {
  assert.deepEqual(frameSecretMatches("4111 1111 1111 1111 and 4155550132"), []);
});

test("does not flag a git SHA or hex hash (common non-secret)", () => {
  assert.deepEqual(frameSecretMatches("commit 9f2c1ab4de5607891234abcd5678ef9012345678"), []);
  assert.equal(looksLikeHighEntropySecret("deadbeefcafebabe0123456789abcdef01234567"), false);
});

test("high-entropy check requires length, mixed classes, and entropy", () => {
  assert.equal(looksLikeHighEntropySecret("short1A"), false); // too short
  assert.equal(looksLikeHighEntropySecret("aaaaaaaaaaaaaaaaaaaaaaaa"), false); // low entropy, one class
  assert.equal(looksLikeHighEntropySecret("A1b2C3d4E5f6G7h8I9j0K1l2"), true); // long, 3 classes, diverse
});

test("shannonEntropy grows with character diversity", () => {
  assert.ok(shannonEntropy("aaaaaaaa") < shannonEntropy("abcdefgh"));
  assert.equal(shannonEntropy(""), 0);
});
