import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { NARRATION_FILE, type NarrationTranscript } from "../../common/narration";
import {
  maskValue,
  redactedSnippet,
  resolveOverlaps,
  scanStructuredPii,
  type SensitiveFinding,
  type SensitiveMatch,
  type SensitiveReport,
  type SensitiveSource,
} from "../../common/sensitive";
import type { RecEvent, SessionMeta } from "../../common/types";
import { readEvents } from "../frames/correlate";
import { createLogger } from "../logger";
import { isValidSessionId, sessionDir } from "../recorder/session-store";
import { scanSecrets } from "./secrets";

const log = createLogger("Sensitive");

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

/** Shortest value we bother redacting — below this, literal replacement would hit
 *  too many innocent substrings elsewhere in the text. */
const MIN_REDACT_LEN = 3;

/** One string to scan, tagged with where it came from and when. */
interface ScanField {
  text: string;
  source: SensitiveSource;
  atMs: number | null;
}

/** The outcome of a scan: a redacted report for the UI plus the raw matched values
 *  (main-process only — used to build the redactor; never sent to the renderer). */
export interface ScanResult {
  report: SensitiveReport;
  /** De-duplicated raw values detected across the session. */
  values: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Well-known (event type, payload key) → provenance, so common findings read
 *  nicely in the report. Any *other* string field in the payload is still scanned
 *  (tagged "other"): the detection surface deliberately covers the WHOLE payload,
 *  matching what the describer's get_events tool can emit, so there is no curated
 *  allow-list to silently drift out of sync with the outgoing data. */
const KNOWN_FIELD_SOURCES: Record<string, Record<string, SensitiveSource>> = {
  "app.activate": { title: "window-title", url: "url" },
  "app.title-change": { title: "window-title" },
  "browser.url": { url: "url", title: "window-title" },
  "terminal.command": { command: "command" },
  "clipboard.change": { textPreview: "clipboard" },
  marker: { note: "note" },
};

/** Pull every scannable string field from one event's payload, tagged with
 *  provenance + time. Scans the ENTIRE payload — not a hand-picked subset — so any
 *  value get_events could surface (a path in `cwd`, a `host`, a window `path`, or
 *  future PTY output) is covered by the pre-send redaction, not just the primary
 *  fields. Non-string fields (numbers, bounds, format lists) carry no free text. */
function fieldsFromEvent(ev: RecEvent, startedAt: number | null): ScanField[] {
  const atMs = startedAt != null ? ev.epoch - startedAt : null;
  const known = KNOWN_FIELD_SOURCES[ev.type];
  const fields: ScanField[] = [];
  for (const [key, value] of Object.entries(ev.payload)) {
    const text = str(value);
    if (!text) continue;
    fields.push({ text, source: known?.[key] ?? "other", atMs });
  }
  return fields;
}

/** Every scannable text field of a recording, in timeline order. */
function collectFields(dir: string): ScanField[] {
  const fields: ScanField[] = [];

  const meta = readJson<SessionMeta>(path.join(dir, "session.json"));
  const startedAt = typeof meta?.startedAt === "number" ? meta.startedAt : null;

  let events: RecEvent[] = [];
  try {
    events = readEvents(path.join(dir, "events.jsonl"));
  } catch (err) {
    log.warn("could not read events for scan:", err instanceof Error ? err.message : err);
  }
  for (const ev of events) fields.push(...fieldsFromEvent(ev, startedAt));

  const narration = readJson<NarrationTranscript>(path.join(dir, NARRATION_FILE));
  if (narration && Array.isArray(narration.segments)) {
    for (const seg of narration.segments) {
      const text = str(seg?.text);
      if (text) {
        fields.push({
          text,
          source: "narration",
          atMs: typeof seg.atMs === "number" ? seg.atMs : null,
        });
      }
    }
  }

  return fields;
}

/** Run every detection layer over one string and merge them (overlaps resolved). */
async function matchesFor(text: string): Promise<SensitiveMatch[]> {
  const secrets = await scanSecrets(text);
  const pii = scanStructuredPii(text);
  return resolveOverlaps([...secrets, ...pii]);
}

/** Stable identity for deduping the same value seen in the same kind of place. */
function findingKey(source: SensitiveSource, match: SensitiveMatch): string {
  return `${source}|${match.category}|${match.value}`;
}

/**
 * Scan one recording for potentially sensitive details in the text that Analyze
 * would send to GitHub Copilot. Scans EVERY string field of every recorded event
 * — the whole payload, not a curated subset — because the describer's get_events
 * tool can surface any payload field (window titles, URLs, clipboard previews,
 * commands, cwd/host/path, markers…); plus transcribed voice narration. Runs the
 * secret + structured-PII detection layers over each field.
 *
 * Runs entirely on this computer and is best-effort / non-throwing — an unreadable
 * artifact simply contributes no fields. Returns a redacted {@link SensitiveReport}
 * (masked values + short redacted context only) plus the raw matched `values` for
 * the caller's redactor. The report NEVER carries raw values; the `values` array
 * stays in the main process and is never persisted or sent to the renderer.
 *
 * Note: this inspects text only. Secrets merely *visible* in screen frames are
 * handled separately by the frame OCR + blur seam in the describer's get_frames.
 */
export async function scanSession(sessionId: string): Promise<ScanResult> {
  const dir = sessionDir(sessionId); // throws on an unsafe id (traversal guard)
  const fields = collectFields(dir);

  const byKey = new Map<string, SensitiveFinding>();
  const values = new Set<string>();
  // Payload fields repeat verbatim across events (app name, cwd, host, url), so
  // cache detector results by exact text to avoid re-scanning identical strings.
  const scanCache = new Map<string, SensitiveMatch[]>();
  for (const field of fields) {
    let matches = scanCache.get(field.text);
    if (!matches) {
      try {
        matches = await matchesFor(field.text);
      } catch (err) {
        log.warn("field scan failed:", err instanceof Error ? err.message : err);
        continue;
      }
      scanCache.set(field.text, matches);
    }
    for (const match of matches) {
      if (match.value.length >= MIN_REDACT_LEN) values.add(match.value);
      const key = findingKey(field.source, match);
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        // Keep the earliest known time so the finding points at first exposure.
        if (field.atMs != null && (existing.atMs == null || field.atMs < existing.atMs)) {
          existing.atMs = field.atMs;
        }
        continue;
      }
      byKey.set(key, {
        category: match.category,
        label: match.label,
        severity: match.severity,
        source: field.source,
        redactedValue: maskValue(match.value),
        snippet: redactedSnippet(field.text, match, matches),
        atMs: field.atMs,
        occurrences: 1,
      });
    }
  }

  const findings = [...byKey.values()].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const at = (a.atMs ?? Infinity) - (b.atMs ?? Infinity);
    if (at !== 0) return at;
    return a.label.localeCompare(b.label);
  });

  const counts: SensitiveReport["counts"] = {};
  for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;

  const report: SensitiveReport = {
    sessionId,
    scannedAt: Date.now(),
    totalFindings: findings.length,
    highSeverityCount: findings.filter((f) => f.severity === "high").length,
    counts,
    findings,
  };
  return { report, values: [...values] };
}

/**
 * Build a redactor that replaces every detected raw value with its mask. Literal,
 * longest-first replacement so a value contained in another (e.g. a token inside a
 * URL) is masked as the longer match first. Values shorter than MIN_REDACT_LEN are
 * ignored to avoid masking innocent substrings.
 */
export function buildRedactor(values: string[]): (text: string) => string {
  const unique = [...new Set(values.filter((v) => v.length >= MIN_REDACT_LEN))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const value of unique) {
      if (out.includes(value)) out = out.split(value).join(maskValue(value));
    }
    return out;
  };
}

/** Where the (raw-value-free) UI summary is cached per session. */
const SENSITIVE_REPORT_FILE = "sensitive-report.json";

/**
 * Persist the redaction summary next to the analysis so the review survives app
 * restarts and navigation (the live {@link SensitiveReport} is otherwise transient).
 * Passing `undefined` (protection off / nothing hidden) clears any stale summary so
 * a later "nothing found" re-analysis doesn't resurface an old report. The report
 * already carries only masked values + counts, so this never writes raw secrets.
 * Best-effort: a write failure must never break Analyze.
 */
export function saveSensitiveReport(sessionId: string, report: SensitiveReport | undefined): void {
  if (!isValidSessionId(sessionId)) return;
  const file = path.join(sessionDir(sessionId), SENSITIVE_REPORT_FILE);
  try {
    if (report) writeFileSync(file, JSON.stringify(report, null, 2));
    else rmSync(file, { force: true });
  } catch (err) {
    log.warn("failed to persist sensitive report:", err);
  }
}

/** Load a persisted redaction summary for a session, or null when there is none
 *  (or the file is missing/corrupt). Shape-guarded so a bad file can't crash the UI. */
export function loadSensitiveReport(sessionId: string): SensitiveReport | null {
  if (!isValidSessionId(sessionId)) return null;
  const raw = readJson<SensitiveReport>(path.join(sessionDir(sessionId), SENSITIVE_REPORT_FILE));
  if (!raw || typeof raw.totalFindings !== "number" || !Array.isArray(raw.findings)) return null;
  return raw;
}
