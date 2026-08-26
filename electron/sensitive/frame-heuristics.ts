// Reading-independent structural detection for the frame (screen-image) path.
//
// WHY THIS EXISTS. Frame redaction blurs on-screen secrets by first OCR'ing the
// image and running our detectors over the recognized text. But OCR is an
// unreliable reader of HIGH-ENTROPY secrets (API keys, tokens, JWTs): every
// character is independent, so there's no linguistic context to disambiguate
// `0/O`, `1/l/I`, `5/S`, `q/g`. We measured this three ways on captured frames —
// Tesseract (any upscale/threshold/PSM), and even a local vision model
// (Florence-2) — and ALL of them misread the exact glyphs. A better reader is the
// wrong axis: transcribing a 40-char random secret from a screenshot is
// unreliable for any reader (a human included).
//
// What DOES survive every reader is the STRUCTURE: a secret is a long, dense,
// high-entropy run of characters, often introduced by a credential-ish label
// (`TOKEN=`, `password:`). Those properties are reading-independent — they hold
// whether or not OCR transcribed the exact glyphs — so we locate a secret by its
// shape, not by reading it. That is what this module does.
//
// Deliberately GENERAL, not a vendor list. We do NOT enumerate issuer prefixes
// (`ghp_`, `AKIA`, `sk_live_`, …): that is an unbounded, ever-churning blocklist
// that does not scale, and it is already covered two better ways — secretlint's
// community-maintained ruleset matches named patterns on clean OCR, and the
// entropy rule below catches the SAME tokens by shape when OCR garbles them. What
// remains here are two content-agnostic principles (Shannon entropy over long
// tokens — the truffleHog technique — and credential-assignment context), so
// there is nothing per-vendor to maintain.
//
// It is deliberately RECALL-first (higher recall, lower precision) and is used
// ONLY on the frame path — never on the text-redaction path, where over-masking
// would corrupt the text the model legitimately needs. On a screenshot an
// occasional extra black box (over a commit SHA or a UUID) is cheap and the user
// reviews the result; a leaked secret is not. The realistic eval measures the
// over-blur this trades for.

import type { SensitiveMatch } from "../../common/sensitive";

/** Minimum length for a bare token to be considered a high-entropy secret. Real
 *  keys/tokens are long; this keeps ordinary identifiers and words out. */
const MIN_TOKEN_LEN = 20;
/** Minimum Shannon entropy (bits/char) for a high-entropy token. Random secrets
 *  sit well above this; repeated or low-diversity strings fall below it. */
const MIN_ENTROPY = 3.2;
/** A token must be at least this fraction alphanumeric to qualify (excludes
 *  punctuation-heavy OCR noise like `(0.0)h(2)h`). */
const MIN_ALNUM_RATIO = 0.75;

/** Secret-bearing assignments: a credential-ish key followed by `=`/`:` and a
 *  value. Catches things the entropy rule alone would miss (short-but-secret
 *  values like a password), and reinforces the token rules. The captured value
 *  (group 1) is what gets blurred. `key`/`id` alone are intentionally excluded —
 *  too generic — in favor of explicit secret words. */
const ASSIGNMENT_RE =
  /(?:api[_\s-]?key|access[_\s-]?key|secret[_\s-]?key|client[_\s-]?secret|secret|token|password|passwd|pwd|bearer|private[_\s-]?key|credentials?|auth[_\s-]?token)\b["'`]?\s*[:=]\s*["'`]?([^\s"'`]{6,})/gi;

/** Tokens that look like a secret by shape but are common, non-sensitive
 *  identifiers we should not blur (keeps over-blur down). Pure-hex strings are
 *  git SHAs / checksums / hashes, not mixed-charset credentials. */
function isCommonNonSecret(token: string): boolean {
  return /^(?:0x)?[0-9a-f]+$/i.test(token);
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** How many of {lowercase, uppercase, digit} a string contains. */
function alnumClasses(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n += 1;
  if (/[A-Z]/.test(s)) n += 1;
  if (/[0-9]/.test(s)) n += 1;
  return n;
}

/** Fraction of characters that are ASCII alphanumeric. */
function alnumRatio(s: string): number {
  const alnum = s.replace(/[^A-Za-z0-9]/g, "").length;
  return s.length === 0 ? 0 : alnum / s.length;
}

/** True when a bare token has the shape of a high-entropy secret. Reading-
 *  independent: it never needs the token to be a valid, checksummed, exact
 *  pattern — just long, diverse, and dense enough to be a random credential. */
export function looksLikeHighEntropySecret(token: string): boolean {
  if (token.length < MIN_TOKEN_LEN) return false;
  if (token.includes("://")) return false; // a URL, not a bare secret
  if (isCommonNonSecret(token)) return false; // hex hash / SHA / id
  if (alnumRatio(token) < MIN_ALNUM_RATIO) return false;
  // Require BOTH a digit and a letter. Random credentials essentially always mix
  // them; this cleanly excludes file paths, dotted identifiers, and prose (letters
  // but no digit) as well as pure digit runs — cards/SSNs/phones, which the
  // checksum PII detectors own.
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  if (alnumClasses(token) < 2) return false;
  return shannonEntropy(token) >= MIN_ENTROPY;
}

function push(
  out: SensitiveMatch[],
  value: string,
  start: number,
  rank: number,
): void {
  if (!value) return;
  out.push({
    category: "api-key",
    label: "Secret-shaped value",
    severity: "high",
    value,
    start,
    end: start + value.length,
    rank,
  });
}

/**
 * Locate secret-shaped regions in a frame's OCR text WITHOUT relying on reading
 * the secret correctly, and WITHOUT a per-vendor prefix list. Emits a
 * {@link SensitiveMatch} for every:
 *   - bare token whose length + character-class entropy make it a random
 *     credential ({@link looksLikeHighEntropySecret}) — this also catches known
 *     issuer tokens (`ghp_…`, `AKIA…`, `eyJ…`) by shape when OCR garbles them;
 *   - value assigned to a credential-ish key (`token=…`, `password: …`).
 *
 * Named-vendor patterns on clean OCR are handled upstream by secretlint, so there
 * is no issuer enumeration to maintain here. Frame-only and recall-first by
 * design; see the file header for the rationale and the precision trade-off.
 * Offsets are into `text` so the caller can map each match back to the OCR word
 * boxes that overlap it.
 */
export function frameSecretMatches(text: string): SensitiveMatch[] {
  if (!text) return [];
  const out: SensitiveMatch[] = [];

  // 1) Assignment right-hand sides (catches short-but-secret values too).
  ASSIGNMENT_RE.lastIndex = 0;
  for (let m = ASSIGNMENT_RE.exec(text); m; m = ASSIGNMENT_RE.exec(text)) {
    const value = m[1];
    if (value) push(out, value, m.index + m[0].length - value.length, 60);
    if (m.index === ASSIGNMENT_RE.lastIndex) ASSIGNMENT_RE.lastIndex += 1;
  }

  // 2) Bare high-entropy tokens (the reading-independent workhorse).
  const TOKEN_RE = /\S+/g;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    const raw = m[0];
    // Trim surrounding punctuation but keep the interior intact, tracking the
    // offset shift so the emitted span still lines up with `text`.
    const lead = raw.length - raw.replace(/^[^A-Za-z0-9]+/, "").length;
    const core = raw.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
    if (looksLikeHighEntropySecret(core)) push(out, core, m.index + lead, 50);
  }

  return out;
}
