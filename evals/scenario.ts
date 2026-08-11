// Scenario model + authoring helpers for the describer evals.
//
// A scenario is a fixed, synthetic recording (a list of captured OS events) plus
// a rubric describing what a good analysis of it looks like. Fixtures are
// deterministic and video-less on purpose: they isolate the part of the system
// with real variance — the multi-turn Copilot describer — from flaky live
// capture, so the eval is repeatable. The events are authored to mirror what the
// real collectors would emit for the same task (see evals/mocks/*.html for the
// pages these flows reference).

import { EventType } from "../common/events";
import type { TerminalCommandIndex } from "../common/terminal";
import type { RecEvent, SessionMeta } from "../common/types";

/** An event as authored in a scenario: just a time offset + type + payload. */
export interface RawEvent {
  /** Milliseconds since the user pressed Start. */
  atMs: number;
  type: string;
  source?: string;
  payload: Record<string, unknown>;
}

/** Deterministic scoring rubric for a scenario's analysis. */
export interface Rubric {
  /** Every keyword must appear (case-insensitive) in the intent sentence. */
  intentKeywordsAll?: string[];
  /** Each group: at least one of its keywords must appear in the intent. */
  intentKeywordsAny?: string[][];
  minSteps?: number;
  maxSteps?: number;
  /** Each app must appear in the union of the steps' apps/text (substring, ci). */
  expectedApps?: string[];
  /**
   * Ordered flow: each group is a set of synonyms; the groups must appear as an
   * ordered subsequence across the steps (any synonym satisfies its group).
   */
  orderedActions?: string[][];
  /** Anywhere across the steps' text, each group needs at least one match. */
  mustMentionAny?: string[][];
  /** None of these may appear anywhere in the intent or steps text (noise). */
  forbidden?: string[];
}

export interface Scenario {
  /** Slug used for the session id and result keys. */
  id: string;
  /** Human-readable title. */
  title: string;
  platform?: NodeJS.Platform;
  /** Ground-truth description of the task (for docs + the optional LLM judge). */
  truth: string;
  /** Produce the ordered raw events for this recording. */
  build: () => RawEvent[];
  /** Optional full recorded-terminal artifacts for output-aware describer evals. */
  terminal?: {
    commands: TerminalCommandIndex[];
    output: { atMs: number; text: string }[];
  };
  /** Raw values that must not survive local redaction into the final analysis. */
  sensitiveValues?: string[];
  rubric: Rubric;
}

// --- Event authoring helpers ------------------------------------------------

const RECORDER_APP = "Skill Recorder";

/** Focus the Skill Recorder window (to press Start/Stop) — recorder bracketing. */
export const recorder = (atMs: number, title = "Skill Recorder"): RawEvent => ({
  atMs,
  type: EventType.AppActivate,
  source: "active-window",
  payload: { app: RECORDER_APP, title },
});

export const appActivate = (
  atMs: number,
  app: string,
  title: string,
  extra: Partial<Record<string, unknown>> = {},
): RawEvent => ({
  atMs,
  type: EventType.AppActivate,
  source: "active-window",
  payload: { app, title, ...extra },
});

export const titleChange = (atMs: number, app: string, title: string): RawEvent => ({
  atMs,
  type: EventType.AppTitleChange,
  source: "active-window",
  payload: { app, title },
});

export const browserUrl = (
  atMs: number,
  app: string,
  url: string,
  title?: string,
): RawEvent => {
  let host: string | undefined;
  try {
    host = new URL(url).host;
  } catch {
    host = undefined;
  }
  return {
    atMs,
    type: EventType.BrowserUrl,
    source: "active-window",
    payload: { app, url, host, ...(title ? { title } : {}) },
  };
};

/** A page visit: emit both the app focus (with url) and a browser.url event. */
export const visit = (
  atMs: number,
  app: string,
  url: string,
  title: string,
): RawEvent[] => {
  let host: string | undefined;
  try {
    host = new URL(url).host;
  } catch {
    host = undefined;
  }
  return [
    appActivate(atMs, app, title, { url, host }),
    browserUrl(atMs + 1, app, url, title),
  ];
};

export const clipboard = (atMs: number, text: string, formats: string[] = ["text/plain"]): RawEvent => ({
  atMs,
  type: EventType.ClipboardChange,
  source: "clipboard",
  payload: {
    formats,
    length: text.length,
    hash: `h${text.length}_${text.slice(0, 8)}`,
    textPreview: text,
  },
});

export const terminal = (
  atMs: number,
  command: string,
  cwd: string,
  extra: Partial<Record<string, unknown>> = {},
): RawEvent => ({
  atMs,
  type: EventType.TerminalCommand,
  source: "terminal",
  payload: {
    commandId: `cmd-${atMs}`,
    command,
    cwd,
    shell: "zsh",
    ...extra,
  },
});

export const marker = (atMs: number, note: string): RawEvent => ({
  atMs,
  type: EventType.Marker,
  source: "ui",
  payload: { note },
});

// --- Materialization --------------------------------------------------------

/** Stamp raw events into on-disk RecEvents (seq/t/epoch) sorted by time. */
export function materializeEvents(raw: RawEvent[], startedAt: number): RecEvent[] {
  const sorted = [...raw].sort((a, b) => a.atMs - b.atMs);
  return sorted.map((e, i) => ({
    seq: i,
    t: e.atMs,
    epoch: startedAt + e.atMs,
    type: e.type,
    source: e.source ?? "eval",
    payload: e.payload,
  }));
}

export function makeSessionMeta(
  id: string,
  startedAt: number,
  durationMs: number,
  platform: NodeJS.Platform,
): SessionMeta {
  return {
    id,
    startedAt,
    stoppedAt: startedAt + durationMs,
    platform,
    appVersion: "eval",
  };
}
