import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CAPTURED_FRAME_MANIFEST_VERSION } from "../../common/frames";
import { approveAll, CopilotClient, type CopilotSession } from "@github/copilot-sdk";

import {
  AnalysisSchema,
  toAnalysis,
  type Analysis,
  type AnalysisFeedback,
  type AnalysisSubmission,
} from "../../common/analysis";
import { COPILOT_SIGNED_OUT_ERROR, type AnalyzeProgress } from "../../common/ipc";
import type { SessionMeta } from "../../common/types";
import { FrameExtractor } from "../frames/extractor";
import { createLogger } from "../logger";
import { copilotConnectionOption, withStartupTimeout } from "../copilot-cli-path";
import { sessionsRoot, sessionDir, isValidSessionId } from "../recorder/session-store";
import { DESCRIBER_INSTRUCTIONS } from "./instructions";
import { createDescriberTools, type RedactionContext } from "./tools";

const log = createLogger("Describer");

/** How long a single agent turn may run before we give up (multi-tool loop). */
const TURN_TIMEOUT_MS = 180_000;

/** Cap on simultaneously-held live agent sessions; oldest idle ones are evicted. */
const MAX_LIVE_SESSIONS = 4;

const KICKOFF_PROMPT =
  "Reconstruct what the user did in this recording. Start with get_timeline, then read events " +
  "where anything is unclear, and look at frames only where the events are ambiguous. When " +
  "confident, call submit_analysis with the overall intent and the ordered list of steps.";

const NUDGE_PROMPT =
  "Please call submit_analysis now with your best analysis of the overall intent and the ordered steps.";

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface VideoMeta {
  file: string;
  startEpoch: number;
  durationMs: number;
  framesFile?: string;
  framesVersion?: number;
}

/** A live, resumable analysis session for one recording. */
interface LiveSession {
  sessionId: string;
  sessionDir: string;
  copilot: CopilotSession;
  revision: number;
  feedbackLog: Analysis["feedbackLog"];
  /** Mutable capture slot the `submit_analysis` tool writes into. */
  holder: { submission: AnalysisSubmission | undefined };
  /** Mutable redaction slot; set per turn so tools mask outgoing data. */
  redaction: { current: RedactionContext | null };
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Load a persisted analysis from a session dir (validated), or null. */
export function loadPersistedAnalysis(sessionId: string): Analysis | null {
  if (!isValidSessionId(sessionId)) return null;
  const file = path.join(sessionsRoot(), sessionId, "analysis.json");
  const raw = readJson<unknown>(file);
  if (!raw) return null;
  const parsed = AnalysisSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Drives the multi-turn GitHub Copilot CLI agent that turns a recording's captured
 * signals into an intent + ordered steps, and revises them from NL feedback. Owns
 * a single shared {@link CopilotClient}; keeps one live session per recording so the
 * feedback loop stays in the same conversation. Streams progress out via a callback.
 * The deterministic baseline `description.md` remains the fallback when Copilot is
 * unavailable (callers surface the thrown error).
 */
export class Describer {
  private client: CopilotClient | null = null;
  private clientStart: Promise<CopilotClient> | null = null;
  private model: string | undefined;
  private readonly live = new Map<string, LiveSession>();
  private readonly active = new Set<string>();

  constructor(private readonly emitProgress: (p: AnalyzeProgress) => void) {}

  /** First pass: reconstruct the session from scratch. */
  async analyze(sessionId: string, redaction?: RedactionContext): Promise<Analysis> {
    if (this.active.has(sessionId)) throw new Error("An analysis is already running for this session.");
    this.active.add(sessionId);
    try {
      this.emit(sessionId, "start", "Starting analysis…");
      await this.disposeLive(sessionId); // fresh conversation each explicit analyze
      const live = await this.createLive(sessionId);
      live.redaction.current = redaction ?? null;
      return await this.runTurn(live, KICKOFF_PROMPT);
    } finally {
      this.active.delete(sessionId);
    }
  }

  /** Later pass: fold in NL feedback and revise holistically. */
  async feedback(sessionId: string, fb: AnalysisFeedback, redaction?: RedactionContext): Promise<Analysis> {
    if (this.active.has(sessionId)) throw new Error("An analysis is already running for this session.");
    this.active.add(sessionId);
    try {
      this.emit(sessionId, "start", "Re-analyzing with your feedback…");
      const live = this.live.get(sessionId) ?? (await this.createLive(sessionId));
      live.redaction.current = redaction ?? null;
      const prior = loadPersistedAnalysis(sessionId);
      // The feedback round is recorded in runTurn only after it produces a
      // revision, so a failed turn never leaves a phantom log entry.
      return await this.runTurn(live, renderFeedbackPrompt(fb, prior), fb);
    } finally {
      this.active.delete(sessionId);
    }
  }

  /**
   * Apply a direct edit to the analysis — a user correction, NOT a re-analysis: the
   * agent is not invoked. Any subset of {title, intent, steps} may be patched; the
   * rest are untouched. Blank intent is ignored (a session always keeps a goal); the
   * title may be cleared. The edited steps become the source of truth downstream.
   */
  async edit(
    sessionId: string,
    patch: { title?: string; intent?: string; steps?: Analysis["steps"] },
  ): Promise<Analysis> {
    if (this.active.has(sessionId)) throw new Error("Wait for the current analysis to finish before editing.");
    const prior = loadPersistedAnalysis(sessionId);
    if (!prior) throw new Error("There is no analysis to edit yet.");
    const next: Analysis = { ...prior };
    if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.intent !== undefined && patch.intent.trim()) next.intent = patch.intent.trim();
    if (patch.steps !== undefined) next.steps = patch.steps;
    this.persist(sessionDir(sessionId), next);
    return next;
  }

  /** Abort an in-flight run for a session. */
  async cancel(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) await live.copilot.abort().catch(() => undefined);
  }

  /** True while an analyze/feedback turn is actively running for this session. */
  isAnalyzing(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * Drop any live agent conversation held for a session and forget it. Called
   * before the session's files are deleted so no agent keeps its directory open.
   */
  async forget(sessionId: string): Promise<void> {
    await this.disposeLive(sessionId);
  }

  /**
   * Disconnect live sessions that aren't currently running — called when the
   * library window closes, so idle agent conversations don't linger. The active
   * (in-flight) session, if any, is left alone.
   */
  async evictIdle(): Promise<void> {
    for (const [id, live] of this.live) {
      if (this.active.has(id)) continue;
      this.live.delete(id);
      await live.copilot.disconnect().catch(() => undefined);
    }
  }

  /** Tear down the client + all live sessions (called on app quit). */
  async dispose(): Promise<void> {
    for (const [id] of this.live) await this.disposeLive(id);
    if (this.client) await this.client.stop().catch(() => undefined);
    this.client = null;
    this.clientStart = null;
  }

  // --- internals -----------------------------------------------------------

  private emit(sessionId: string, phase: AnalyzeProgress["phase"], message: string): void {
    this.emitProgress({ sessionId, phase, message });
  }

  private async ensureClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.clientStart) return this.clientStart;
    this.clientStart = (async () => {
      const connOpts = copilotConnectionOption();
      if (connOpts) log.info("CLI path resolved from node_modules");
      const client = new CopilotClient(connOpts);
      await withStartupTimeout(client.start(), "Copilot CLI (Describer)");
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        await client.stop().catch(() => undefined);
        throw new Error(COPILOT_SIGNED_OUT_ERROR);
      }
      this.model = await this.pickVisionModel(client);
      log.info("Copilot ready", auth.login ? `as ${auth.login}` : "", this.model ? `· model ${this.model}` : "");
      this.client = client;
      return client;
    })();
    try {
      return await this.clientStart;
    } catch (err) {
      this.clientStart = null;
      throw err;
    }
  }

  /** Prefer a vision-capable, enabled model (frames need vision). */
  private async pickVisionModel(client: CopilotClient): Promise<string | undefined> {
    const override = process.env.SKILL_RECORDER_MODEL;
    if (override) return override;
    try {
      const models = await client.listModels();
      const vision = models.filter(
        (m) => m.capabilities?.supports?.vision && m.policy?.state !== "disabled",
      );
      return vision[0]?.id;
    } catch (err) {
      log.warn("listModels failed; using CLI default model:", msg(err));
      return undefined;
    }
  }

  private async createLive(sessionId: string): Promise<LiveSession> {
    const dir = sessionDir(sessionId);
    const meta = readJson<SessionMeta>(path.join(dir, "session.json"));
    if (!meta) throw new Error(`Session ${sessionId} not found or has no session.json.`);

    const extractor = buildExtractor(dir);
    const holder: LiveSession["holder"] = { submission: undefined };
    const redaction: LiveSession["redaction"] = { current: null };

    const tools = createDescriberTools({
      sessionDir: dir,
      startedAt: meta.startedAt,
      extractor,
      redaction,
      onProgress: (m) => this.emit(sessionId, "working", m),
      onSubmit: (s) => {
        holder.submission = s;
      },
    });

    const client = await this.ensureClient();
    const config = {
      systemMessage: { mode: "append" as const, content: DESCRIBER_INSTRUCTIONS },
      tools,
      onPermissionRequest: approveAll,
      workingDirectory: dir,
      enableHostGitOperations: false,
      infiniteSessions: { enabled: false },
      ...(this.model ? { model: this.model } : {}),
    };
    // Always constrain the agent to our sandboxed custom tools. If the runtime
    // cannot honor the allowlist we fail the analysis rather than silently
    // creating an unsandboxed session — which, combined with approveAll, would
    // auto-run the SDK's full default toolset in the user's environment.
    const copilot = await client.createSession({
      ...config,
      availableTools: tools.map((t) => t.name),
    });

    const prior = loadPersistedAnalysis(sessionId);
    const live: LiveSession = {
      sessionId,
      sessionDir: dir,
      copilot,
      revision: prior?.revision ?? 0,
      feedbackLog: prior?.feedbackLog ?? [],
      holder,
      redaction,
    };
    this.live.set(sessionId, live);
    this.evictOverflow(sessionId);
    return live;
  }

  /** Keep at most MAX_LIVE_SESSIONS live; disconnect the oldest idle ones. */
  private evictOverflow(keep: string): void {
    for (const [id, live] of this.live) {
      if (this.live.size <= MAX_LIVE_SESSIONS) break;
      if (id === keep || this.active.has(id)) continue;
      this.live.delete(id);
      void live.copilot.disconnect().catch(() => undefined);
    }
  }

  private async disposeLive(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    await live.copilot.disconnect().catch(() => undefined);
  }

  private async runTurn(
    live: LiveSession,
    prompt: string,
    pendingFeedback?: AnalysisFeedback,
  ): Promise<Analysis> {
    const narrationFile = path.join(live.sessionDir, "narration.json");
    const narrationSourceUpdatedAt = existsSync(narrationFile)
      ? statSync(narrationFile).mtimeMs
      : null;
    live.holder.submission = undefined;
    this.emit(live.sessionId, "working", "Thinking…");
    try {
      await live.copilot.sendAndWait(prompt, TURN_TIMEOUT_MS);
    } catch (err) {
      // Don't leave the agent running past our timeout/abort — reclaim the turn.
      await live.copilot.abort().catch(() => undefined);
      throw new Error(`Analysis run failed: ${msg(err)}`);
    }
    if (!live.holder.submission) {
      this.emit(live.sessionId, "working", "Asking the agent to finalize its analysis…");
      await live.copilot.sendAndWait(NUDGE_PROMPT, TURN_TIMEOUT_MS).catch(() => undefined);
    }
    const submission = live.holder.submission;
    if (!submission) throw new Error("The agent finished without submitting an analysis.");

    live.revision += 1;
    // Record the feedback round only now that it actually produced a revision, so
    // a failed turn above never leaves a phantom entry with a duplicated revision.
    if (pendingFeedback) {
      live.feedbackLog = [
        ...live.feedbackLog,
        {
          revision: live.revision,
          at: Date.now(),
          overall: pendingFeedback.overall,
          steps: pendingFeedback.steps,
        },
      ];
    }
    this.emit(live.sessionId, "drafting", "Finalizing analysis…");
    const analysis = toAnalysis(
      live.sessionId,
      live.revision,
      submission,
      [...live.feedbackLog],
      narrationSourceUpdatedAt,
    );
    this.persist(live.sessionDir, analysis);
    this.emit(live.sessionId, "done", `Analysis ready (revision ${analysis.revision}).`);
    return analysis;
  }

  private persist(sessionDir: string, analysis: Analysis): void {
    try {
      writeFileSync(path.join(sessionDir, "analysis.json"), JSON.stringify(analysis, null, 2));
      writeFileSync(path.join(sessionDir, "analysis.md"), renderAnalysisMarkdown(analysis));
    } catch (err) {
      log.warn("failed to persist analysis:", msg(err));
    }
  }
}

function buildExtractor(sessionDir: string): FrameExtractor | null {
  const video = readJson<VideoMeta>(path.join(sessionDir, "video.json"));
  if (!video) return null;
  const videoPath = path.join(sessionDir, video.file);
  const capturedFramesPath = video.framesFile
    ? path.join(sessionDir, video.framesFile)
    : undefined;
  const hasVideo = existsSync(videoPath);
  const hasCapturedFrames = Boolean(capturedFramesPath && existsSync(capturedFramesPath));
  if (!hasVideo && !hasCapturedFrames) return null;
  return new FrameExtractor({
    ...(hasVideo ? { videoPath } : {}),
    ...(hasCapturedFrames ? { capturedFramesPath } : {}),
    capturedFramesExpected: video.framesVersion === CAPTURED_FRAME_MANIFEST_VERSION,
    framesDir: path.join(sessionDir, "frames"),
    anchorEpochMs: video.startEpoch,
    durationSec: video.durationMs > 0 ? video.durationMs / 1000 : undefined,
  });
}

function renderFeedbackPrompt(fb: AnalysisFeedback, prior: Analysis | null): string {
  const lines: string[] = [
    "The user reviewed your analysis and left feedback. Revise the ENTIRE analysis accordingly and",
    "call submit_analysis again. Re-examine signals (get_events / get_frames) where the feedback",
    "points to a gap or error. Keep step ids stable for steps that don't change.",
    "",
  ];
  if (prior) {
    lines.push("Your current analysis:");
    lines.push(`- intent (${prior.intentConfidence}): ${prior.intent}`);
    for (const s of prior.steps) lines.push(`- ${s.id}: ${s.title} — ${s.detail}`);
    lines.push("");
  }
  lines.push(`Overall-intent feedback: ${fb.overall?.trim() ? fb.overall.trim() : "(none)"}`);
  if (fb.steps.length) {
    lines.push("Per-step feedback:");
    for (const s of fb.steps) {
      const title = prior?.steps.find((p) => p.id === s.stepId)?.title ?? "";
      lines.push(`- ${s.stepId}${title ? ` (${title})` : ""}: ${s.note}`);
    }
  }
  return lines.join("\n");
}

/** Human-readable rendering of an analysis (persisted alongside analysis.json). */
export function renderAnalysisMarkdown(a: Analysis): string {
  const out: string[] = [];
  out.push(`# ${a.title?.trim() || "Session analysis"}`);
  out.push("");
  out.push(`**Intent** (${a.intentConfidence}): ${a.intent}`);
  if (a.intentRationale) out.push(`\n${a.intentRationale}`);
  out.push("");
  out.push(`## Steps`);
  a.steps.forEach((s, i) => {
    const span =
      s.startMs != null ? ` _(${(s.startMs / 1000).toFixed(1)}s${s.endMs != null ? `–${(s.endMs / 1000).toFixed(1)}s` : ""})_` : "";
    out.push(`\n### ${i + 1}. ${s.title}${span}`);
    out.push(s.detail);
    if (s.apps.length) out.push(`\n- apps: ${s.apps.join(", ")}`);
    if (s.evidence.length) out.push(`- evidence: ${s.evidence.join("; ")}`);
    out.push(`- confidence: ${s.confidence}`);
  });
  out.push("");
  out.push(`_Revision ${a.revision} · generated ${new Date(a.createdAt).toISOString()}_`);
  return out.join("\n") + "\n";
}
