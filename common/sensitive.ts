// Renderer-safe types, masking, and structured-PII detectors for the on-device
// pre-send scan Skill Recorder runs before it sends captured text to GitHub
// Copilot on Analyze (window/document titles, URLs, clipboard previews, terminal
// commands, markers, and voice narration).
//
// This module is pure and dependency-free so it can run in either process and be
// unit-tested in isolation. It owns only the *structured* PII detectors (email,
// payment card, SSN, phone) — high-precision, checksum-validated where possible.
// The other detection layer lives in the Electron main process because it needs a
// Node-only dep: secrets/credentials via `@secretlint/core`
// (electron/sensitive/secrets.ts). Both layers emit {@link SensitiveMatch}es and
// are merged with {@link resolveOverlaps}. Nothing here ever emits or stores a raw
// value on its own; callers use {@link maskValue} / {@link redactText}.

/** The kind of sensitive detail a match represents. */
export type SensitiveCategory =
  // Secrets / credentials (secretlint, main process).
  | "private-key"
  | "api-key"
  | "jwt"
  | "password"
  // Structured PII (this module).
  | "email"
  | "credit-card"
  | "ssn"
  | "phone";

/** How strongly a finding should be treated as a real leak. */
export type SensitiveSeverity = "high" | "medium" | "low";

/** Where in a recording a finding was captured (its provenance). */
export type SensitiveSource =
  | "window-title"
  | "url"
  | "command"
  | "clipboard"
  | "note"
  | "narration"
  | "frame"
  // A captured field with no dedicated provenance (e.g. a terminal cwd, a window
  // path/host). Scanned for completeness so detection covers the whole payload.
  | "other";

/** One raw detector hit inside a single string. Carries the matched value in
 *  memory only; never persist or display it directly — mask it first. */
export interface SensitiveMatch {
  category: SensitiveCategory;
  /** Human label for the UI, e.g. "GitHub token" or "Email address". */
  label: string;
  severity: SensitiveSeverity;
  /** The matched substring (in-memory only). */
  value: string;
  /** Half-open [start, end) offsets of {@link value} within the scanned string. */
  start: number;
  end: number;
  /** Priority when two matches overlap the same span (specific/validated > generic).
   *  Secrets rank highest, then structured PII. */
  rank: number;
}

const SEVERITY_RANK: Record<SensitiveSeverity, number> = { high: 3, medium: 2, low: 1 };

/** A regex-backed detector spec for structured PII. */
interface DetectorSpec {
  category: SensitiveCategory;
  label: string;
  severity: SensitiveSeverity;
  /** Higher wins when two detectors overlap the same span (specific > generic). */
  rank: number;
  pattern: RegExp;
  /** Capture-group index holding the sensitive value; defaults to the whole match. */
  valueGroup?: number;
  /** Extra validation (e.g. Luhn); return false to reject a candidate. */
  accept?: (value: string, match: RegExpExecArray) => boolean;
}

/** Structured-PII detectors. High precision on purpose: each either has a
 *  distinctive shape or is checksum/format-validated, so ordinary prose, hashes,
 *  version strings, and bare digit runs don't trip it. */
const STRUCTURED_PII: DetectorSpec[] = [
  {
    category: "credit-card",
    label: "Payment card number",
    severity: "high",
    rank: 55,
    // 13–19 digits with optional single space/dash separators, anchored to a digit
    // at both ends so a trailing separator is never captured into the value.
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (value) => {
      const digits = value.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    category: "ssn",
    label: "US Social Security number",
    severity: "high",
    rank: 55,
    pattern: /\b(\d{3})-(\d{2})-(\d{4})\b/g,
    accept: (_value, match) => {
      const area = match[1];
      const group = match[2];
      const serial = match[3];
      return (
        area !== "000" &&
        area !== "666" &&
        area[0] !== "9" &&
        group !== "00" &&
        serial !== "0000"
      );
    },
  },
  {
    category: "phone",
    label: "Phone number",
    severity: "low",
    rank: 45,
    // North-American grouped format (3-3-4) with a required separator between
    // groups, so a bare 10-digit run — or a card/SSN — doesn't match. An optional
    // country code (+1 / 1) may lead it. The leading `(?<!\d)` stops that optional
    // "1" from latching onto the trailing digit of a preceding number (e.g. an SSN
    // ending in "1" right before the phone): without it the match would grow to
    // overlap that number and get dropped by resolveOverlaps, silently leaking the
    // phone.
    pattern: /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g,
    accept: (value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
    },
  },
  {
    category: "phone",
    label: "Phone number",
    severity: "low",
    rank: 45,
    // International E.164: must start with "+" and hold 8–15 digits total, with
    // optional spaces/dots/dashes as visual grouping.
    pattern: /\+\d(?:[\s.-]?\d){7,14}(?!\d)/g,
    accept: (value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15;
    },
  },
  {
    category: "email",
    label: "Email address",
    severity: "medium",
    rank: 40,
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

/** Luhn checksum validation for a digit string (payment-card sanity check). */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function detectorMatches(text: string, specs: DetectorSpec[]): SensitiveMatch[] {
  const out: SensitiveMatch[] = [];
  for (const spec of specs) {
    // Fresh lastIndex per scan; `pattern` is a module-level /g regex.
    spec.pattern.lastIndex = 0;
    for (let m = spec.pattern.exec(text); m; m = spec.pattern.exec(text)) {
      const value = spec.valueGroup != null ? m[spec.valueGroup] : m[0];
      if (!value) continue;
      if (spec.accept && !spec.accept(value, m)) continue;
      const offset = spec.valueGroup != null ? m[0].indexOf(value) : 0;
      const start = m.index + (offset < 0 ? 0 : offset);
      out.push({
        category: spec.category,
        label: spec.label,
        severity: spec.severity,
        value,
        start,
        end: start + value.length,
        rank: spec.rank,
      });
      // Guard against zero-length matches spinning forever.
      if (m.index === spec.pattern.lastIndex) spec.pattern.lastIndex++;
    }
  }
  return out;
}

/** Drop matches fully or partially overlapping a higher-priority match, keeping
 *  the strongest (severity, then rank, then length) for each region. Works across
 *  every detection layer (secrets, structured PII, frame heuristics). */
export function resolveOverlaps(matches: SensitiveMatch[]): SensitiveMatch[] {
  const ordered = [...matches].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const rank = b.rank - a.rank;
    if (rank !== 0) return rank;
    const len = b.end - b.start - (a.end - a.start);
    if (len !== 0) return len;
    return a.start - b.start;
  });
  const kept: SensitiveMatch[] = [];
  for (const m of ordered) {
    if (kept.some((k) => m.start < k.end && k.start < m.end)) continue;
    kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Scan a single string for structured PII (email, payment card, SSN, phone) and
 * return every distinct match, ordered by position with overlaps resolved. Pure
 * and deterministic. Secrets are detected by the main-process secretlint layer and
 * merged separately.
 */
export function scanStructuredPii(text: string): SensitiveMatch[] {
  if (!text) return [];
  return resolveOverlaps(detectorMatches(text, STRUCTURED_PII));
}

/**
 * Mask a sensitive value for display or storage: reveals at most a few leading /
 * trailing characters and hides the rest behind a fixed-width mask (so the true
 * length isn't leaked). Short values are masked entirely.
 */
export function maskValue(value: string): string {
  const MASK = "••••";
  if (!value) return "";
  if (value.length <= 6) return MASK;
  const head = value.slice(0, 2);
  const tail = value.slice(-2);
  return `${head}${MASK}${tail}`;
}

/** Replace every match's span in `text` with a mask, leaving the rest intact. */
export function redactText(text: string, matches: SensitiveMatch[]): string {
  if (matches.length === 0) return text;
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const m of ordered) {
    if (m.start < cursor) continue; // skip any residual overlap
    out += text.slice(cursor, m.start) + maskValue(m.value);
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

/**
 * A short, already-redacted context window around a match — enough for the user
 * to recognize where the detail came from without exposing the value itself.
 *
 * `all` should contain every match detected in `text`; each one that overlaps the
 * window is masked, so an adjacent sensitive value never leaks raw through this
 * snippet. It defaults to just the focus match to preserve callers that only have
 * the one.
 */
export function redactedSnippet(
  text: string,
  match: SensitiveMatch,
  all: SensitiveMatch[] = [match],
  pad = 32,
): string {
  const from = Math.max(0, match.start - pad);
  const to = Math.min(text.length, match.end + pad);
  const slice = text.slice(from, to);
  const local = all
    .filter((m) => m.end > from && m.start < to)
    .map((m) => ({
      ...m,
      start: Math.max(0, m.start - from),
      end: Math.min(slice.length, m.end - from),
    }));
  const redacted = redactText(slice, local).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${redacted}${to < text.length ? "…" : ""}`;
}

/* --- Session-level report shapes (shared with the IPC layer) --------------- */

/** One deduplicated sensitive detail found across a recording. Safe to persist
 *  and display — it carries only masked / redacted text, never the raw value. */
export interface SensitiveFinding {
  category: SensitiveCategory;
  label: string;
  severity: SensitiveSeverity;
  /** Where it was captured (window title, url, clipboard, command, note, voice). */
  source: SensitiveSource;
  /** Masked form of the detected value (e.g. `gh••••cd`). */
  redactedValue: string;
  /** Short redacted context, e.g. `…api_key=gh••••cd npm install…`. */
  snippet: string;
  /** ms since the recording started, for context; null when unknown. */
  atMs: number | null;
  /** How many times this exact value+source pair was seen. */
  occurrences: number;
}

/** The result of scanning one recording for sensitive details before Analyze. */
export interface SensitiveReport {
  sessionId: string;
  scannedAt: number;
  totalFindings: number;
  highSeverityCount: number;
  counts: Partial<Record<SensitiveCategory, number>>;
  findings: SensitiveFinding[];
  /** What was blurred in screen images during the analyze run. Filled in after
   *  frames are processed; absent when nothing on-screen was covered. Images are
   *  summarized as counts only — the on-screen text itself is never retained. */
  images?: { framesBlurred: number; regionsBlurred: number };
}

/** Human label for a finding's provenance. */
export function sourceLabel(source: SensitiveSource): string {
  switch (source) {
    case "window-title":
      return "Window title";
    case "url":
      return "URL";
    case "command":
      return "Terminal command";
    case "clipboard":
      return "Clipboard";
    case "note":
      return "Note";
    case "narration":
      return "Voice narration";
    case "frame":
      return "On-screen text";
    case "other":
      return "Other captured text";
  }
}
