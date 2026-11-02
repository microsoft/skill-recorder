import { access, lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { AnalysisSchema, type Analysis } from "../common/analysis";
import { readAudioNarrationLanguage } from "../common/audio";
import type { SessionSummary } from "../common/ipc";
import {
  NARRATION_FILE,
  type NarrationLanguage,
  type NarrationTranscript,
} from "../common/narration";
import type { SessionMeta } from "../common/types";
import { createLogger } from "./logger";
import { readImport } from "./imports/metadata";
import { isValidSessionId, sessionDir, sessionsRoot } from "./recorder/session-store";

const log = createLogger("Sessions");
const SIZE_STAT_BATCH = 64;

/** True when `file` exists (non-throwing `fs.access`). */
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Load and validate a session's persisted analysis without blocking the main thread. */
async function loadAnalysis(dir: string): Promise<Analysis | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "analysis.json"), "utf8"));
    const parsed = AnalysisSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function loadNarration(
  dir: string,
): Promise<{ segmentCount: number; updatedAt: number } | null> {
  const file = path.join(dir, NARRATION_FILE);
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as NarrationTranscript;
    if (!Array.isArray(raw?.segments)) return null;
    const info = await stat(file);
    return { segmentCount: raw.segments.length, updatedAt: info.mtimeMs };
  } catch {
    return null;
  }
}

async function loadAudioLanguage(dir: string): Promise<NarrationLanguage | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "audio.json"), "utf8")) as unknown;
    return readAudioNarrationLanguage(raw);
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Sum file and link sizes without following links outside the session directory. */
export async function sessionDirectorySize(root: string): Promise<number> {
  const pending = [root];
  let total = 0;

  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else files.push(file);
    }

    for (let start = 0; start < files.length; start += SIZE_STAT_BATCH) {
      const stats = await Promise.all(
        files.slice(start, start + SIZE_STAT_BATCH).map(async (file) => {
          try {
            return await lstat(file);
          } catch (error) {
            if (isMissing(error)) return null;
            throw error;
          }
        }),
      );
      for (const info of stats) total += info?.size ?? 0;
    }
  }

  return total;
}

/** Build the library summary for a single session dir, or null if it isn't one. */
async function summarize(root: string, name: string): Promise<SessionSummary | null> {
  const dir = path.join(root, name);
  try {
    if (!(await stat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }

  let meta: SessionMeta | null = null;
  try {
    meta = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")) as SessionMeta;
  } catch {
    return null; // not a valid session dir
  }
  if (!meta?.id) return null;
  let imported;
  if (meta.source === "imported-video") {
    try {
      imported = readImport(dir);
      if (!imported) throw new Error("Missing import.json");
    } catch (error) {
      log.warn(`invalid imported session ${name}:`, error);
      return null;
    }
  }

  const [
    analysis,
    processed,
    hasVideo,
    narrationLanguage,
    narration,
    hasSkill,
    hasAutomation,
    sizeBytes,
  ] = await Promise.all([
      loadAnalysis(dir),
      exists(path.join(dir, "bundle.json")),
      exists(path.join(dir, "video.json")),
      loadAudioLanguage(dir),
      loadNarration(dir),
      exists(path.join(dir, "skill.json")),
      exists(path.join(dir, "built-automation.json")),
      sessionDirectorySize(dir).catch((error) => {
        log.warn(
          `could not measure session ${name}:`,
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }),
  ]);

  return {
    id: meta.id,
    ...(imported ? { imported } : {}),
    startedAt: meta.startedAt ?? null,
    stoppedAt: meta.stoppedAt ?? null,
    durationMs: meta.startedAt && meta.stoppedAt ? meta.stoppedAt - meta.startedAt : null,
    sizeBytes,
    processed,
    hasVideo,
    hasAudio: narrationLanguage !== null,
    narrationLanguage,
    hasNarration: narration !== null,
    narrationSegmentCount: narration?.segmentCount ?? null,
    narrationUpdatedAt: narration?.updatedAt ?? null,
    hasSkill,
    hasAutomation,
    analysis: analysis
      ? {
          revision: analysis.revision,
          createdAt: analysis.createdAt,
          narrationSourceUpdatedAt: analysis.narrationSourceUpdatedAt,
          title: analysis.title ?? "",
          intent: analysis.intent,
          intentConfidence: analysis.intentConfidence,
          stepCount: analysis.steps.length,
        }
      : null,
  };
}

/** Enumerate saved recordings for the sessions library, newest first. */
export async function listSessions(): Promise<SessionSummary[]> {
  const root = sessionsRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return []; // no sessions dir yet
  }

  const summaries = await Promise.all(
    names.filter((name) => isValidSessionId(name)).map((name) => summarize(root, name)),
  );
  const out = summaries.filter((s): s is SessionSummary => s !== null);
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out;
}

/**
 * Permanently remove a saved recording and every artifact under its directory
 * (events, video, frames, analysis). The id is validated via {@link sessionDir},
 * which throws on any unsafe segment, so this can never escape the sessions root.
 * `force` makes an already-missing session a no-op rather than an error.
 */
export async function deleteSession(id: string): Promise<void> {
  const dir = sessionDir(id); // throws on traversal / invalid id
  await rm(dir, { recursive: true, force: true });
}
