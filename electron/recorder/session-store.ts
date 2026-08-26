import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";

import { app } from "electron";

import type { RecEvent, SessionMeta } from "../../common/types";
import { createLogger } from "../logger";

const log = createLogger("SessionStore");

/** Root folder that holds one sub-directory per recorded session. */
export function sessionsRoot(): string {
  const override = process.env.SKILL_RECORDER_SESSIONS_DIR;
  if (override) return path.resolve(override);
  return path.join(app.getPath("userData"), "sessions");
}

/**
 * True when `id` is safe to use as a single path segment under {@link sessionsRoot}.
 *
 * This is a traversal guard, not a format check: renderer- or caller-supplied ids
 * must be a single segment with no path separators and no `..`, so `path.join`
 * can never escape the sessions root. It intentionally accepts any reasonable slug
 * (our own `YYYYMMDD-HHMMSS-<hex>` ids, but also eval/test/imported ids) rather
 * than coupling to {@link makeSessionId}'s exact shape.
 */
export function isValidSessionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    !id.includes("..") &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
  );
}

/** Absolute directory for a session id. Throws on an unsafe id (no traversal). */
export function sessionDir(id: string): string {
  if (!isValidSessionId(id)) throw new Error(`Invalid session id: ${String(id)}`);
  return path.join(sessionsRoot(), id);
}

/**
 * Owns the on-disk artifacts for a single recording session:
 *   <sessionsRoot>/<id>/session.json      session metadata
 *   <sessionsRoot>/<id>/events.jsonl      append-only event stream
 *   <sessionsRoot>/<id>/frames/           extracted keyframes (later milestones)
 */
export class SessionStore {
  readonly meta: SessionMeta;
  readonly dir: string;
  private readonly eventsStream: WriteStream;
  private readonly startMonotonic: number;
  private readonly closed: Promise<void>;
  private count = 0;
  private streamError: Error | null = null;

  constructor(meta: SessionMeta) {
    this.meta = meta;
    this.dir = path.join(sessionsRoot(), meta.id);
    mkdirSync(path.join(this.dir, "frames"), { recursive: true });
    this.eventsStream = createWriteStream(path.join(this.dir, "events.jsonl"), { flags: "a" });
    // Own the stream's failures: a Writable with no 'error' listener rethrows the
    // error as an uncaught exception, which crashes the whole main process (and the
    // recording in progress). Capture it instead so callers can react.
    this.eventsStream.on("error", (err) => {
      this.streamError = err instanceof Error ? err : new Error(String(err));
      log.error("events stream write failed:", this.streamError.message);
    });
    this.closed = new Promise<void>((resolve) => {
      this.eventsStream.once("close", () => resolve());
    });
    this.startMonotonic = performance.now();
    this.writeMeta();
  }

  get eventCount(): number {
    return this.count;
  }

  /** The first error the events stream reported, if any. */
  get writeError(): Error | null {
    return this.streamError;
  }

  /** Resolves once the events stream has fully flushed to disk (after finalize). */
  whenClosed(): Promise<void> {
    return this.closed;
  }

  private writeMeta(): void {
    writeFileSync(path.join(this.dir, "session.json"), JSON.stringify(this.meta, null, 2));
  }

  append(type: string, source: string, payload: Record<string, unknown> = {}): RecEvent {
    const ev: RecEvent = {
      seq: this.count,
      t: performance.now() - this.startMonotonic,
      epoch: Date.now(),
      type,
      source,
      payload,
    };
    this.eventsStream.write(JSON.stringify(ev) + "\n");
    this.count++;
    return ev;
  }

  finalize(stoppedAt: number): void {
    this.meta.stoppedAt = stoppedAt;
    this.writeMeta();
    this.eventsStream.end();
  }

  /** Force-release the events stream — used to recover from a finalize failure. */
  dispose(): void {
    this.eventsStream.destroy();
  }
}
