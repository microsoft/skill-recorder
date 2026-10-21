import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildBundle } from "../common/bundle";
import { MEANINGFUL_EVENT_TYPES } from "../common/correlation";
import type { CorrelationResult } from "../common/correlation";
import { renderDescription } from "../common/describe";
import type { SessionMeta } from "../common/types";
import { CorrelationEngine, readEvents } from "./frames/correlate";
import { FrameExtractor } from "./frames/extractor";
import { createLogger } from "./logger";
import type { VideoResult } from "./video/recorder";

const log = createLogger("Pipeline");

function readMeta(sessionDir: string): SessionMeta | null {
  const p = path.join(sessionDir, "session.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SessionMeta;
  } catch (err) {
    log.warn("unreadable session.json:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Opportunistic frame stage: if source snapshots were captured, grab one at each
 * meaningful non-video event and correlate. We deliberately DO NOT scan the whole
 * recording — events are the primary signal; anything they miss is surfaced as probe
 * *suggestions* and harvested later, only where confidence is low. Best-effort:
 * returns null when there are no usable captured frames.
 */
async function runFrameStage(sessionDir: string): Promise<CorrelationResult | null> {
  const videoJsonPath = path.join(sessionDir, "video.json");
  if (!existsSync(videoJsonPath)) return null;

  let video: VideoResult;
  try {
    video = JSON.parse(readFileSync(videoJsonPath, "utf8")) as VideoResult;
  } catch (err) {
    log.warn("unreadable video.json; skipping frame stage:", err instanceof Error ? err.message : err);
    return null;
  }

  const capturedFramesPath = video.framesFile && path.join(sessionDir, video.framesFile);
  if (!capturedFramesPath || !existsSync(capturedFramesPath)) {
    log.warn("captured frames missing; skipping frame stage");
    return null;
  }

  const extractor = new FrameExtractor({
    capturedFramesPath,
    framesDir: path.join(sessionDir, "frames"),
    anchorEpochMs: video.startEpoch,
    durationSec: video.durationMs > 0 ? video.durationMs / 1000 : undefined,
  });

  const anchors = readEvents(path.join(sessionDir, "events.jsonl"))
    .filter((e) => MEANINGFUL_EVENT_TYPES.has(e.type))
    .map((e) => ({ tMs: e.epoch, reason: e.type }));

  try {
    await extractor.extractAtEpochs(anchors);
  } catch (err) {
    log.warn("frame extraction failed:", err instanceof Error ? err.message : err);
  }

  try {
    return await new CorrelationEngine(extractor, sessionDir).run();
  } catch (err) {
    log.warn("correlation failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Post-stop processing for a completed session. Always produces `bundle.json`
 * (segmented steps) and `description.md` (baseline narrative) from the primary
 * event stream; enriches them with correlated captured frames when available.
 * Strictly best-effort — never throws into the recorder.
 */
export async function processSession(sessionDir: string): Promise<void> {
  const meta = readMeta(sessionDir);
  if (!meta) {
    log.warn("no session.json; skipping processing for", path.basename(sessionDir));
    return;
  }

  const events = readEvents(path.join(sessionDir, "events.jsonl"));
  const correlation = await runFrameStage(sessionDir);

  try {
    const bundle = buildBundle({ meta, events, correlation });
    writeFileSync(path.join(sessionDir, "bundle.json"), JSON.stringify(bundle, null, 2));
    writeFileSync(path.join(sessionDir, "description.md"), renderDescription(bundle));
    log.info(
      `bundle: ${bundle.stats.stepCount} steps, ${bundle.stats.meaningfulEventCount} events` +
        `${bundle.stats.frameCount ? `, ${bundle.stats.frameCount} frames` : ""} → description.md`,
    );
  } catch (err) {
    log.warn("bundle/describe failed:", err instanceof Error ? err.message : err);
  }
}
