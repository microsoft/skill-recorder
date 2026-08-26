import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Tool } from "@github/copilot-sdk";

import { AnalysisSubmissionSchema, type AnalysisSubmission } from "../../common/analysis";
import { MEANINGFUL_EVENT_TYPES } from "../../common/correlation";
import type { SessionBundle } from "../../common/bundle";
import { NARRATION_FILE, type NarrationTranscript } from "../../common/narration";
import type { RecEvent } from "../../common/types";
import { readEvents } from "../frames/correlate";
import type { FrameExtractor } from "../frames/extractor";
import type { FrameRedactor } from "../sensitive/frame-redact";
import { createLogger } from "../logger";

const log = createLogger("Describer/tools");

/** Redaction applied to a session's data before it leaves the machine. Threaded
 *  through a mutable slot so the same live tools pick up fresh values each turn. */
export interface RedactionContext {
  /** Mask every detected raw value in an outgoing text string. */
  redactText: (text: string) => string;
  /** Frame OCR + blur policy for get_frames, or null to serve frames unchanged. */
  frameRedactor: FrameRedactor | null;
}

/** Everything a session's tools are bound to. */
export interface ToolContext {
  sessionDir: string;
  /** `session.json` startedAt (epoch ms) — origin of the agent's `atMs` clock. */
  startedAt: number;
  /** Frame service, or null when the session has no video. */
  extractor: FrameExtractor | null;
  /** Mutable redaction slot; `current` is set per turn (null = no redaction). */
  redaction: { current: RedactionContext | null };
  /** Streamed to the UI as the agent works. */
  onProgress?: (message: string) => void;
  /** Called when the agent submits a (validated) analysis. */
  onSubmit: (submission: AnalysisSubmission) => void;
}

const MAX_IMAGES_PER_CALL = 6;
const MAX_STR = 2000;
/** Cap rows returned by get_events so an un-windowed call can't dump the whole log. */
const MAX_EVENTS = 500;

const truncate = (v: unknown): unknown =>
  typeof v === "string" && v.length > MAX_STR ? v.slice(0, MAX_STR) + "…[truncated]" : v;

function readBundle(sessionDir: string): SessionBundle | null {
  const p = path.join(sessionDir, "bundle.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SessionBundle;
  } catch {
    return null;
  }
}

function readNarration(sessionDir: string): NarrationTranscript | null {
  const p = path.join(sessionDir, NARRATION_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as NarrationTranscript;
  } catch {
    return null;
  }
}

/**
 * Build the custom in-process tools exposed to one Copilot session. Handlers run
 * in the Electron main process (dispatched over JSON-RPC by the SDK), read the
 * session's captured signals, and — for frames — return the JPEGs **inline** so
 * the model can see the screen without any `view`/`bash` tool. `submit_analysis`
 * captures guaranteed-structured output. The whole surface is sandboxed to the
 * one session dir.
 */
export function createDescriberTools(ctx: ToolContext): Tool[] {
  const { sessionDir, startedAt, extractor, onSubmit } = ctx;
  const progress = (m: string) => ctx.onProgress?.(m);
  // Mask detected sensitive values in every outgoing text field (null slot = no-op).
  const redact = (s: string): string => ctx.redaction.current?.redactText(s) ?? s;
  const rel = (epoch: number) => Math.round(epoch - startedAt);
  const abs = (atMs: number) => startedAt + atMs;
  const sec = (atMs: number) => (atMs / 1000).toFixed(1);
  const mmss = (atMs: number) => {
    const total = Math.max(0, Math.round(atMs / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };

  const getTimeline: Tool = {
    name: "get_timeline",
    description:
      "Return the segmented session timeline: ordered steps with their start time (atMs, ms since recording start), duration, app, urls, titles, commands, clipboard counts and markers. Call this first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      progress("Reading the timeline…");
      const bundle = readBundle(sessionDir);
      if (!bundle) {
        return "No timeline is available yet (bundle.json missing). Use get_events to read the raw event stream instead.";
      }
      const view = {
        durationMs: bundle.session.durationMs,
        platform: bundle.session.platform,
        stats: bundle.stats,
        steps: bundle.steps.map((s) => ({
          index: s.index,
          atMs: rel(s.startMs),
          durationMs: s.durationMs,
          boundary: s.boundary,
          app: s.app,
          titles: s.titles,
          hosts: s.hosts,
          urls: s.urls,
          commands: s.commands,
          clipboardCount: s.clipboardCount,
          markers: s.markers,
          frameCount: s.frames.length,
          summary: s.summary,
        })),
      };
      return redact(JSON.stringify(view, null, 2));
    },
  };

  const getEvents: Tool = {
    name: "get_events",
    description:
      "Return the raw event stream (with clipboard text, full titles, full URLs, commands). Optionally filter by `types` (e.g. [\"browser.url\",\"clipboard.change\"]) and/or a time window `fromMs`/`toMs` (atMs, ms since recording start). Defaults to the meaningful events across the whole session.",
    parameters: {
      type: "object",
      properties: {
        types: { type: "array", items: { type: "string" }, description: "Event types to include." },
        fromMs: { type: "number", description: "Window start (atMs)." },
        toMs: { type: "number", description: "Window end (atMs)." },
      },
      additionalProperties: false,
    },
    handler: (raw) => {
      const args = (raw ?? {}) as { types?: string[]; fromMs?: number; toMs?: number };
      const wanted = args.types && args.types.length ? new Set(args.types) : null;
      const from = typeof args.fromMs === "number" ? args.fromMs : -Infinity;
      const to = typeof args.toMs === "number" ? args.toMs : Infinity;
      progress(
        `Reading events ${args.fromMs != null ? sec(args.fromMs) + "s" : "start"}–${
          args.toMs != null ? sec(args.toMs) + "s" : "end"
        }…`,
      );
      let events: RecEvent[];
      try {
        events = readEvents(path.join(sessionDir, "events.jsonl"));
      } catch (err) {
        return `Could not read events: ${err instanceof Error ? err.message : String(err)}`;
      }
      const all = events
        .filter((e) => (wanted ? wanted.has(e.type) : MEANINGFUL_EVENT_TYPES.has(e.type)))
        .map((e) => ({ e, atMs: rel(e.epoch) }))
        .filter(({ atMs }) => atMs >= from && atMs <= to)
        .map(({ e, atMs }) => {
          const payload: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(e.payload)) payload[k] = truncate(v);
          return { seq: e.seq, atMs, type: e.type, source: e.source, ...payload };
        });
      // Bound the payload so a long, un-windowed session can't return thousands
      // of rows in one tool result. When truncated, tell the agent how to narrow.
      const rows = all.slice(0, MAX_EVENTS);
      const truncated = all.length > rows.length;
      return redact(
        JSON.stringify(
          {
            count: rows.length,
            total: all.length,
            ...(truncated
              ? { truncated: true, note: `Showing the first ${MAX_EVENTS} of ${all.length} events. Narrow with fromMs/toMs or filter by types.` }
              : {}),
            events: rows,
          },
          null,
          2,
        ),
      );
    },
  };

  const listFrames: Tool = {
    name: "list_frames",
    description:
      "List the screen frames already available for this session (file, atMs, source, reason). Returns an empty list when no video was recorded. Use get_frames to actually view frames.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      progress("Listing available frames…");
      if (!extractor) return JSON.stringify({ hasVideo: false, frames: [] });
      const frames = extractor.manifest.map((f) => ({
        file: f.file,
        atMs: rel(f.tMs),
        source: f.source,
        reason: f.reason,
      }));
      return JSON.stringify({ hasVideo: true, frames }, null, 2);
    },
  };

  const getFrames: Tool = {
    name: "get_frames",
    description:
      "Sample and VIEW the available 1 fps screen snapshots within a time window [fromMs, toMs] (atMs, ms since recording start) and return them inline as images. Optional `fps` can reduce sampling density but cannot add detail beyond the 1 fps capture. Optional `crop` {x,y,w,h} zooms a region. Use only where events are ambiguous.",
    parameters: {
      type: "object",
      properties: {
        fromMs: { type: "number", description: "Window start (atMs)." },
        toMs: { type: "number", description: "Window end (atMs)." },
        fps: { type: "number", description: "Sampling density up to the 1 fps source rate. Default 1." },
        crop: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
          },
          required: ["x", "y", "w", "h"],
          additionalProperties: false,
        },
        reason: { type: "string", description: "Why you need a closer look." },
      },
      required: ["fromMs", "toMs"],
      additionalProperties: false,
    },
    handler: async (raw) => {
      const args = (raw ?? {}) as {
        fromMs?: number;
        toMs?: number;
        fps?: number;
        crop?: { x: number; y: number; w: number; h: number };
        reason?: string;
      };
      if (!extractor) {
        return { textResultForLlm: "No video was recorded for this session; no frames are available.", resultType: "failure" };
      }
      const fromMs = typeof args.fromMs === "number" ? args.fromMs : 0;
      const toMs = typeof args.toMs === "number" ? Math.max(fromMs, args.toMs) : fromMs + 3000;
      progress(`Looking at ${sec(fromMs)}–${sec(toMs)}s…`);
      try {
        await extractor.extractWindow({
          startMs: abs(fromMs),
          endMs: abs(toMs),
          fps: args.fps,
          crop: args.crop,
          reason: args.reason ?? "describer:get_frames",
        });
      } catch (err) {
        log.warn("get_frames extract failed:", err instanceof Error ? err.message : err);
      }

      const inWindow = extractor.manifest.filter((f) => {
        const atMs = rel(f.tMs);
        return atMs >= fromMs && atMs <= toMs;
      });
      if (inWindow.length === 0) {
        return { textResultForLlm: `No frames could be extracted for ${sec(fromMs)}–${sec(toMs)}s.`, resultType: "success" };
      }
      // Evenly sample which frames to attach as images (bounded cost).
      const picks: typeof inWindow = [];
      if (inWindow.length <= MAX_IMAGES_PER_CALL) picks.push(...inWindow);
      else {
        const stride = (inWindow.length - 1) / (MAX_IMAGES_PER_CALL - 1);
        for (let i = 0; i < MAX_IMAGES_PER_CALL; i++) picks.push(inWindow[Math.round(i * stride)]);
      }

      // Advanced protection: frames are the only image channel, so on-screen text
      // must be OCR'd + blurred before any pixels are sent. Policy:
      //   inactive          → serve raw frames (baseline behaviour).
      //   active, not ready  → WITHHOLD frames (assets still loading) — never raw.
      //   active, ready      → blur detected regions per frame; withhold on failure.
      const redactor = ctx.redaction.current?.frameRedactor ?? null;
      const protect = redactor?.active ?? false;
      if (redactor?.active && !redactor.ready) {
        return {
          textResultForLlm:
            "Advanced protection is on but the on-device OCR model could not be made ready (it may still be downloading, or the download failed, for example when offline), so screen frames are being withheld for this window to avoid sending unredacted on-screen text. Proceeding on events and narration; frames become available once the model is ready.",
          resultType: "success",
        };
      }

      const binaryResultsForLlm: { data: string; mimeType: string; type: "image"; description?: string }[] = [];
      let withheld = 0;
      for (const f of picks) {
        const file = path.join(sessionDir, "frames", f.file);
        if (!existsSync(file)) continue;
        try {
          let data: string;
          if (protect && redactor) {
            const buf = await redactor.redactFrame(file);
            if (!buf) {
              // Redaction failed for this frame — withhold it rather than serve raw.
              withheld++;
              continue;
            }
            data = buf.toString("base64");
          } else {
            data = readFileSync(file).toString("base64");
          }
          binaryResultsForLlm.push({
            data,
            mimeType: "image/jpeg",
            type: "image",
            description: `${sec(rel(f.tMs))}s (${f.source}) ${f.file}`,
          });
        } catch (err) {
          log.warn("frame read failed:", err instanceof Error ? err.message : err);
        }
      }
      const listing = inWindow.map((f) => `- ${sec(rel(f.tMs))}s ${f.file} (${f.source})`).join("\n");
      progress(`Attached ${binaryResultsForLlm.length} frame image(s) from ${sec(fromMs)}–${sec(toMs)}s.`);
      const protectNote = protect
        ? ` On-device Advanced protection blurred any detected sensitive on-screen text${withheld ? `; ${withheld} frame(s) were withheld because redaction failed` : ""}.`
        : "";
      return {
        textResultForLlm:
          `Frames in ${sec(fromMs)}–${sec(toMs)}s (${inWindow.length} total, ${binaryResultsForLlm.length} shown as images):\n${listing}${protectNote}`,
        binaryResultsForLlm,
        resultType: "success",
      };
    },
  };

  const getNarration: Tool = {
    name: "get_narration",
    description:
      "Return the user's spoken voice narration for this session as timestamped lines ([mm:ss] text). This is the user's own words describing what they are doing and why, so treat it as the most direct statement of intent and use it to name and order the steps. Optionally pass `query` to return only lines containing that text (case-insensitive). Returns a note when the user recorded no narration.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Only return narration lines containing this text (case-insensitive).",
        },
      },
      additionalProperties: false,
    },
    handler: (raw) => {
      const args = (raw ?? {}) as { query?: string };
      const transcript = readNarration(sessionDir);
      if (!transcript || transcript.segments.length === 0) {
        return "The user did not record any voice narration for this session.";
      }
      progress(args.query ? `Searching narration for “${args.query}”…` : "Reading the voice narration…");
      const q = args.query?.trim().toLowerCase();
      const lines = transcript.segments
        .filter((s) => (q ? s.text.toLowerCase().includes(q) : true))
        .map((s) => `[${mmss(s.atMs)}] ${s.text}`);
      if (lines.length === 0) {
        return `No narration lines match “${args.query}”. Call get_narration with no query to read the whole transcript.`;
      }
      return redact(lines.join("\n"));
    },
  };

  const submitAnalysis: Tool = {
    name: "submit_analysis",
    description:
      "Submit your final structured analysis: the overall intent and the ordered list of steps. Call this exactly once when confident (and again on later turns after incorporating feedback).",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            'A short 2–5 word label for this task in Title Case, under ~40 characters, no trailing period, e.g. "Research Habit Articles" or "Save Teams Chat To Notes". Used as the session name in lists. Write a fresh, scannable name — do NOT just truncate the intent sentence.',
        },
        intent: { type: "string", description: "One sentence naming the user's overall goal." },
        intentConfidence: { type: "string", enum: ["high", "medium", "low"] },
        intentRationale: { type: "string", description: '1–2 sentences of evidence for the intent, in the past tense addressed to the user (e.g. "Navigated to the blog, copied a passage, then searched Google for it"). Avoid the third person.' },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short id, e.g. \"s1\"." },
              title: {
                type: "string",
                description:
                  'A short label naming what the user did, in the past tense addressed to the user (e.g. "Opened the Teams event link", "Searched Google for the passage"). Not imperative or third person.',
              },
              detail: {
                type: "string",
                description:
                  'What happened and why it matters, in 1–3 sentences. Write in the past tense addressed to the user, starting with a past-tense verb (e.g. "Opened the Copilot Studio technical guide."). Do not use the third person ("The user…", "User was…") or the present tense.',
              },
              startMs: { type: "number", description: "Step start (atMs)." },
              endMs: { type: "number", description: "Step end (atMs)." },
              apps: { type: "array", items: { type: "string" } },
              evidence: { type: "array", items: { type: "string" } },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["id", "title", "detail"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "intent", "steps"],
      additionalProperties: false,
    },
    handler: (raw) => {
      const parsed = AnalysisSubmissionSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          textResultForLlm:
            "submit_analysis rejected — the payload did not match the schema. Fix these and call again:\n" +
            parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
          resultType: "failure",
        };
      }
      progress("Received analysis draft.");
      onSubmit(parsed.data);
      return "Analysis recorded. You may stop now.";
    },
  };

  return [getTimeline, getEvents, getNarration, listFrames, getFrames, submitAnalysis];
}
