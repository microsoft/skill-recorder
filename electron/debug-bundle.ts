import { createWriteStream } from "node:fs";
import os from "node:os";

import { ZipArchive } from "archiver";
import { app } from "electron";

import type { DoctorReport } from "../common/ipc";
import { runDoctor } from "./doctor";
import { createLogger } from "./logger";
import { sessionDir } from "./recorder/session-store";

const log = createLogger("DebugBundle");

/**
 * Environment diagnostics captured at download time and written as the bundle's
 * top-level `debug-info.json`. Deliberately separate from the recording itself so
 * it reflects the machine *now*, not when the session was captured.
 */
export interface DebugInfo {
  generatedAt: string;
  sessionId: string;
  app: {
    name: string;
    version: string;
    /** Null on runtimes without `app.getLocale` (e.g. the headless test stub). */
    locale: string | null;
  };
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
    osRelease: string;
    versions: NodeJS.ProcessVersions;
  };
  doctor: DoctorReport;
}

/** Assemble the environment diagnostics that ride alongside a session's files. */
export function buildDebugInfo(sessionId: string): DebugInfo {
  return {
    generatedAt: new Date().toISOString(),
    sessionId,
    app: {
      name: app.getName(),
      version: app.getVersion(),
      locale: typeof app.getLocale === "function" ? app.getLocale() : null,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      versions: process.versions,
    },
    doctor: runDoctor(),
  };
}

/**
 * Stream a single recording into a downloadable `.zip` at `destZipPath`: the
 * entire session directory (events, frames, screen video, voice audio, analysis,
 * …) is included verbatim under `session/`, next to a top-level `debug-info.json`.
 *
 * The whole folder is copied on purpose — this is a debug bundle, so completeness
 * beats size — which means it contains **private capture data**; callers must warn
 * before invoking this. The id is validated via {@link sessionDir}, so it can
 * never escape the sessions root.
 */
export function writeDebugBundle(
  sessionId: string,
  destZipPath: string,
  debugInfo: unknown,
): Promise<void> {
  const dir = sessionDir(sessionId); // throws on traversal / invalid id
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const output = createWriteStream(destZipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on("close", () => done());
    output.on("error", (err) => done(err));
    archive.on("error", (err) => done(err));
    archive.on("warning", (err: NodeJS.ErrnoException) => {
      // A file disappearing mid-archive is best-effort; anything else is fatal.
      if (err.code === "ENOENT") log.warn("archive warning:", err.message);
      else done(err);
    });

    archive.pipe(output);
    archive.append(JSON.stringify(debugInfo, null, 2), { name: "debug-info.json" });
    archive.directory(dir, "session");
    void archive.finalize();
  });
}
