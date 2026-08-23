/**
 * Capture configuration. The recorder captures every available signal on every
 * recording — there is no user-facing capture level. Transparency comes from the
 * in-app "What's recorded" note, not from a tiered picker that mostly described
 * overlapping OS permissions.
 *
 * This module stays the single source of truth for *which* signals exist, so the
 * collectors, the doctor, and the evals all share one shape.
 */

export interface CaptureConfig {
  /** Foreground app switches (app name/bundle/pid). */
  appActivity: boolean;
  /** Clipboard copies (formats, length, hash, short text preview). */
  clipboard: boolean;
  /** Window and document titles. */
  windowTitles: boolean;
  /** Active browser tab URLs. */
  browserUrls: boolean;
  /** Low-fps screen video + extracted keyframes. */
  video: boolean;
  /** Commands and output from the app-owned recorded terminal, when opened. */
  terminal: boolean;
}

export type CaptureSourceKey = keyof CaptureConfig;

/** The recorder always captures everything. */
export const FULL_CAPTURE: CaptureConfig = {
  appActivity: true,
  clipboard: true,
  windowTitles: true,
  browserUrls: true,
  video: true,
  terminal: true,
};

export interface CaptureSourceInfo {
  key: CaptureSourceKey;
  label: string;
  /** Rough setup weight, surfaced only in the doctor: 0 none, 1 one-time OS grant, 3 screen capture. */
  tier: 0 | 1 | 2 | 3;
  /** Short, human description of what this source needs to work (doctor diagnostics). */
  cost: string;
}

/** Source metadata for the doctor report (labels + platform-support diagnostics). */
export const CAPTURE_SOURCES: readonly CaptureSourceInfo[] = [
  { key: "appActivity", label: "App switches", tier: 0, cost: "No permission needed" },
  { key: "clipboard", label: "Clipboard copies", tier: 0, cost: "No permission needed" },
  { key: "windowTitles", label: "Window titles", tier: 1, cost: "One-time OS permission" },
  { key: "browserUrls", label: "Browser URLs", tier: 1, cost: "One-time OS permission" },
  { key: "video", label: "Screen video + keyframes", tier: 3, cost: "Screen-capture permission" },
  { key: "terminal", label: "Recorded terminal", tier: 0, cost: "Only the app terminal" },
];
