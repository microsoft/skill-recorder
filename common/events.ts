// The formal event schema shared by producers (collectors) and consumers
// (session store, timeline, describer). On disk each event is a `RecEvent`
// (see types.ts); this module adds the typed `type` -> `payload` contract that
// makes collectors and the correlation engine type-safe.

/** Canonical event type identifiers, grouped by domain. */
export const EventType = {
  SessionStart: "session.start",
  SessionStop: "session.stop",
  Marker: "marker",
  AppActivate: "app.activate",
  AppTitleChange: "app.title-change",
  ClipboardChange: "clipboard.change",
  TerminalCommand: "terminal.command",
  BrowserUrl: "browser.url",
  VideoStart: "video.start",
  VideoStop: "video.stop",
  FrameCaptured: "frame.captured",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// --- Per-domain payloads (declared as `type` aliases so they are assignable to
// Record<string, unknown> when persisted). Optional fields are platform- or
// collector-specific enrichments. ---

export type SessionStartPayload = { platform: NodeJS.Platform };
export type SessionStopPayload = Record<string, never>;
export type MarkerPayload = { note: string };

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type AppActivatePayload = {
  app: string;
  title: string;
  url?: string;
  host?: string;
  bundleId?: string;
  pid?: number;
  path?: string;
  bounds?: WindowBounds;
};

export type AppTitleChangePayload = { app: string; title: string };

export type ClipboardChangePayload = {
  formats: string[];
  length: number;
  hash: string;
  textPreview?: string;
};

export type TerminalCommandPayload = {
  commandId: string;
  command: string;
  cwd: string;
  shell?: string;
  exitCode?: number;
  durationMs?: number;
  interrupted?: boolean;
  transcriptStartByte?: number;
  transcriptEndByte?: number;
};

export type BrowserUrlPayload = { app: string; url: string; host?: string; title?: string };

export type VideoPayload = { file: string; fps?: number };

export type FrameCapturedPayload = {
  file: string;
  source: "event" | "scene";
  phash?: string;
  correlatedEventSeqs?: number[];
};

/** Maps each event type to its payload shape. */
export interface EventPayloads {
  "session.start": SessionStartPayload;
  "session.stop": SessionStopPayload;
  marker: MarkerPayload;
  "app.activate": AppActivatePayload;
  "app.title-change": AppTitleChangePayload;
  "clipboard.change": ClipboardChangePayload;
  "terminal.command": TerminalCommandPayload;
  "browser.url": BrowserUrlPayload;
  "video.start": VideoPayload;
  "video.stop": VideoPayload;
  "frame.captured": FrameCapturedPayload;
}

/**
 * A not-yet-persisted event as produced by a collector. The session store
 * stamps it with `seq`, `t`, and `epoch` on append.
 */
export type EventInput = {
  [K in EventType]: { type: K; source: string; payload: EventPayloads[K] };
}[EventType];
