export type RecorderState = "idle" | "recording";

export interface SessionMeta {
  id: string;
  startedAt: number; // wall-clock epoch ms
  stoppedAt: number | null;
  platform: NodeJS.Platform;
  appVersion: string;
  /** Absent in recordings made before local video import was introduced. */
  source?: "imported-video";
}

/**
 * A single captured event on the session timeline, as persisted to
 * `events.jsonl`. The typed `type` -> `payload` contract lives in events.ts;
 * this is the storage shape (payload widened to a record).
 */
export interface RecEvent {
  seq: number; // monotonic per-session index (stable id for correlation)
  t: number; // ms since session start (monotonic-derived)
  epoch: number; // wall-clock epoch ms
  type: string; // e.g. "marker", "app.activate", "clipboard.change"
  source: string; // collector name
  payload: Record<string, unknown>;
}
