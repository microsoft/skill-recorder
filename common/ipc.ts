import type { Analysis, AnalysisFeedback, AnalysisStep, Confidence } from "./analysis";
import type { AutomationPlan, BuiltAutomation } from "./automation";
import type { MicrophoneDevice } from "./microphone";
import type { NarrationLanguage } from "./narration";
import type {
  BuiltSkill,
  SkillArchitecture,
  SkillPlan,
  TargetPlacement,
} from "./skill";
import type { RecorderState } from "./types";

/** The last completed session — the one that can be analyzed. */
export interface LastSession {
  id: string;
  /** True once post-processing (bundle/description/frames) has finished. */
  processed: boolean;
}

/** A saved recording as shown in the sessions library. */
export interface SessionSummary {
  id: string;
  startedAt: number | null;
  stoppedAt: number | null;
  durationMs: number | null;
  /** Total bytes occupied by all files under this session's directory. */
  sizeBytes: number | null;
  /** True once post-processing produced a bundle. */
  processed: boolean;
  hasVideo: boolean;
  /** True when the user opted into narration and usable audio was saved. */
  hasAudio: boolean;
  /** Selected source language for saved audio, or null when no audio exists. */
  narrationLanguage: NarrationLanguage | null;
  /** True once transcription completed, including recordings with no detected speech. */
  hasNarration: boolean;
  narrationSegmentCount: number | null;
  narrationUpdatedAt: number | null;
  /** True once a skill has been built and persisted for this session. */
  hasSkill: boolean;
  /** True once an automation has been built and persisted for this session. */
  hasAutomation: boolean;
  /** Present once the describer has produced an analysis for this session. */
  analysis: {
    revision: number;
    createdAt: number;
    narrationSourceUpdatedAt: number | null;
    title: string;
    intent: string;
    intentConfidence: Confidence;
    stepCount: number;
  } | null;
}

export type NarrationModelState = "missing" | "downloading" | "ready" | "error";
export type NarrationPhase = "idle" | "loading" | "downloading" | "transcribing";

/** Shared model/job state shown in the HUD and Sessions library. */
export interface NarrationStatus {
  model: NarrationModelState;
  phase: NarrationPhase;
  progress: number | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  activeSessionId: string | null;
  error: string | null;
}

export interface NarrationActionResult {
  ok: boolean;
  outcome?: "ready" | "transcribed" | "no-speech" | "already-transcribed" | "model-missing";
  error?: string;
}

export interface RecorderStatus {
  state: RecorderState;
  sessionId: string | null;
  startedAt: number | null;
  /** Source language fixed for the active recording's narration. */
  narrationLanguage: NarrationLanguage;
  eventCount: number;
  transition: "none" | "starting" | "stopping" | "discarding";
  microphone: {
    state: "off" | "starting" | "on" | "stopping" | "error";
    error: string | null;
    activeDevice: MicrophoneDevice | null;
  };
  lastFinish: {
    sessionId: string;
    outcome: "saved" | "discarded";
  } | null;
  /** Set after a recording stops; drives the "Analyze" affordance. */
  lastSession: LastSession | null;
}

/** Streamed to the renderer while the describer agent works. */
export interface AnalyzeProgress {
  sessionId: string;
  phase: "start" | "working" | "drafting" | "done" | "error";
  message: string;
}

/** Result of an analyze / feedback round. */
export interface AnalyzeResult {
  ok: boolean;
  analysis?: Analysis;
  error?: string;
}

/** Feedback payload sent from the renderer for a re-analysis round. */
export interface AnalysisFeedbackInput extends AnalysisFeedback {
  sessionId: string;
}

/** A direct edit to the analysis, applied without re-running the agent. Any subset
 *  of fields may be sent; the rest are left untouched. */
export interface AnalysisEditInput {
  sessionId: string;
  /** New short label; empty string clears it (list falls back to the intent). */
  title?: string;
  /** New one-sentence goal; blank/whitespace is ignored (intent can't be emptied). */
  intent?: string;
  /** The full, user-edited ordered steps; replaces the current steps when present. */
  steps?: AnalysisStep[];
}

/* --- Skill Builder -------------------------------------------------------- */

/** Streamed to the renderer while the skill-builder agent works. */
export interface SkillBuildProgress {
  sessionId: string;
  phase: "start" | "working" | "drafting" | "done" | "error";
  message: string;
}

/** Start a build (or refine one) for a session's analysis. */
export interface SkillBuildInput {
  sessionId: string;
  /** Target architecture (Scout or Cowork). */
  architecture: SkillArchitecture;
  /** Natural-language refinement for the current plan; omit for the first pass. */
  feedback?: string;
}

/** Result of a propose/refine round: the plan to show the user. */
export interface SkillPlanResult {
  ok: boolean;
  plan?: SkillPlan;
  error?: string;
}

/**
 * Where a built skill lands:
 * - **install** — write it into the target agent's live skills folder (Scout auto-loads it).
 * - **export** — download it to a folder the user picks (the only option for Cowork).
 */
export type SkillPlacement = TargetPlacement;

/** Result of finalizing + placing a skill. */
export interface SkillCreateResult {
  ok: boolean;
  skill?: BuiltSkill;
  /** Absolute path of the placed SKILL.md. */
  path?: string;
  /** How the skill was placed (echoed back for the done screen). */
  placement?: SkillPlacement;
  /** True when the user dismissed the export destination dialog — a cancel, not an error. */
  canceled?: boolean;
  error?: string;
}

/* --- Automation Builder --------------------------------------------------- */

/** Streamed to the renderer while the automation-builder agent works. */
export interface AutomationBuildProgress {
  sessionId: string;
  phase: "start" | "working" | "drafting" | "done" | "error";
  message: string;
}

/** Start an automation build (or refine one) for a session's analysis. */
export interface AutomationBuildInput {
  sessionId: string;
  /** Target architecture (automations are Scout-only today). */
  architecture: SkillArchitecture;
  /** Natural-language refinement for the current plan; omit for the first pass. */
  feedback?: string;
}

/** Result of a propose/refine round: the automation plan to show the user. */
export interface AutomationPlanResult {
  ok: boolean;
  plan?: AutomationPlan;
  error?: string;
}

/** Result of finalizing + exporting an automation bundle. */
export interface AutomationCreateResult {
  ok: boolean;
  automation?: BuiltAutomation;
  /** Absolute path of the exported automation.json. */
  path?: string;
  error?: string;
}

export interface StartResult {
  ok: boolean;
  sessionId?: string;
  /** The recording has not started; the renderer must show the pre-recording warning. */
  privacyWarningRequired?: boolean;
  error?: string;
}

/** Per-session capture choices the user makes in the HUD before recording. */
export interface StartOptions {
  /** Capture microphone narration for this session (opt-in, off by default). */
  narration?: boolean;
  /** Source language to preserve in the transcript. Defaults to English. */
  narrationLanguage?: NarrationLanguage;
  /** Device selected for the initial narration segment; defaults to the OS input. */
  microphoneDeviceId?: string;
}

export interface StopResult {
  ok: boolean;
  sessionId?: string;
  sessionDir?: string;
  error?: string;
}

export interface DiscardResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

export interface MicrophoneResult {
  ok: boolean;
  state?: RecorderStatus["microphone"]["state"];
  error?: string;
}

export interface NarrationLanguageResult {
  ok: boolean;
  language?: NarrationLanguage;
  error?: string;
}

export type MicrophonePermissionState = "unknown" | "granted" | "denied";

/** Shared pre-recording microphone preference and current device catalog. */
export interface MicrophoneSettingsStatus {
  narrationEnabled: boolean;
  permission: MicrophonePermissionState;
  devices: MicrophoneDevice[];
  /** The preferred device, retained even while it is disconnected. */
  preferredDeviceId: string;
  preferredDeviceLabel: string;
  /** The device that will actually be requested for the next microphone segment. */
  selectedDeviceId: string;
  selectedDeviceLabel: string;
  preferredDeviceUnavailable: boolean;
  fallback: string | null;
  error: string | null;
}

export interface MicrophoneSettingsResult {
  ok: boolean;
  status: MicrophoneSettingsStatus;
  error?: string;
}

export interface MarkerResult {
  ok: boolean;
  error?: string;
}

export interface DeleteSessionResult {
  ok: boolean;
  error?: string;
}

/** Result of packaging a recording into a downloadable debug bundle (.zip). */
export interface DebugBundleResult {
  ok: boolean;
  /** Absolute path of the written .zip on success. */
  path?: string;
  /** True when the user dismissed the save dialog — a cancel, not an error. */
  canceled?: boolean;
  error?: string;
}

export interface CopilotInfo {
  ok: boolean;
  path: string | null;
}

/** Result of asking the app to open a terminal on the bundled CLI's sign-in command. */
export interface CopilotSignInResult {
  ok: boolean;
  /** The exact command the terminal was asked to run, so the user can run it themselves. */
  command?: string;
  error?: string;
}

/**
 * Message every Copilot-backed feature throws when the CLI has no stored credentials.
 * Skill Recorder ships its own Copilot CLI in `node_modules`, so there is usually no
 * global `copilot` command to run — the renderer matches this message to offer the
 * in-app sign-in affordance instead.
 */
export const COPILOT_SIGNED_OUT_ERROR =
  "GitHub Copilot isn't signed in on this computer yet. Sign in below, then try again.";

/** Whether an error from a Copilot-backed feature means "no credentials yet". */
export function isCopilotSignedOutError(error?: string | null): boolean {
  return typeof error === "string" && error.includes("isn't signed in on this computer");
}

/** Which foreground-window provider is available on this platform. */
export interface ActiveWindowInfo {
  ok: boolean;
  provider: "koffi" | "get-windows" | "missing";
  path: string | null;
  error?: string;
}

/** How, and whether, active-tab URLs can be read on this platform. */
export interface BrowserUrlInfo {
  kind: "applescript" | "uia" | "none";
  supported: boolean;
}

/** One capture source in the doctor report, annotated with platform support. */
export interface DoctorSource {
  key: string;
  label: string;
  tier: number;
  cost: string;
  /** False when this source can't work on the current platform. */
  supported: boolean;
  /** Short reason shown when unsupported, or a setup nudge. */
  note?: string;
}

export interface DoctorReport {
  platform: NodeJS.Platform;
  copilotCli: CopilotInfo;
  activeWindow: ActiveWindowInfo;
  browserUrl: BrowserUrlInfo;
  sessionsDir: string;
  activeSources: DoctorSource[];
}

/** IPC channel names — the single source of truth shared by main + preload. */
export const IPC = {
  start: "recorder:start",
  startConfirmed: "recorder:start-confirmed",
  stop: "recorder:stop",
  discard: "recorder:discard",
  microphone: "recorder:microphone",
  narrationLanguage: "recorder:narration-language",
  microphoneSettings: "microphone:settings",
  microphoneNarration: "microphone:narration",
  microphoneDevice: "microphone:device",
  microphoneSettingsChanged: "microphone:settings-changed",
  status: "recorder:status",
  marker: "recorder:marker",
  doctor: "doctor:check",
  copilotSignIn: "copilot:sign-in",
  statusChanged: "recorder:status-changed",
  recordingPrivacyReviewed: "recorder:privacy-reviewed",
  recordingPrivacyWarningRequested: "recorder:privacy-warning-requested",
  narrationStatus: "narration:status",
  narrationDownload: "narration:download",
  narrationTranscribe: "narration:transcribe",
  narrationStatusChanged: "narration:status-changed",
  analyze: "analyze:start",
  analyzeFeedback: "analyze:feedback",
  getAnalysis: "analyze:get",
  updateAnalysis: "analyze:update",
  cancelAnalysis: "analyze:cancel",
  analyzeProgress: "analyze:progress",
  listSessions: "sessions:list",
  deleteSession: "sessions:delete",
  exportDebugBundle: "sessions:export-debug",
  buildSkill: "skill:build",
  createSkill: "skill:create",
  getSkill: "skill:get",
  cancelSkill: "skill:cancel",
  revealSkill: "skill:reveal",
  skillProgress: "skill:progress",
  buildAutomation: "automation:build",
  createAutomation: "automation:create",
  getAutomation: "automation:get",
  cancelAutomation: "automation:cancel",
  revealAutomation: "automation:reveal",
  automationProgress: "automation:progress",
  openLibrary: "ui:open-library",
  closeLibrary: "ui:close-library",
  recordingControlsExpanded: "ui:recording-controls-expanded",
} as const;

/** Shape exposed on `window.skillRecorder` by the preload bridge. */
export interface SkillRecorderApi {
  /** Request a start; may require the pre-recording privacy warning first. */
  start(): Promise<StartResult>;
  /** Start once after the user explicitly proceeds through the privacy warning. */
  confirmStart(): Promise<StartResult>;
  markRecordingPrivacyReviewed(): Promise<void>;
  onRecordingPrivacyWarningRequested(cb: () => void): () => void;
  stop(): Promise<StopResult>;
  discard(): Promise<DiscardResult>;
  setMicrophoneEnabled(enabled: boolean): Promise<MicrophoneResult>;
  setNarrationLanguage(language: NarrationLanguage): Promise<NarrationLanguageResult>;
  microphoneSettings(): Promise<MicrophoneSettingsStatus>;
  setNarrationEnabled(enabled: boolean): Promise<MicrophoneSettingsResult>;
  selectMicrophone(deviceId: string): Promise<MicrophoneSettingsResult>;
  onMicrophoneSettingsChanged(
    cb: (status: MicrophoneSettingsStatus) => void,
  ): () => void;
  status(): Promise<RecorderStatus>;
  marker(note: string): Promise<MarkerResult>;
  doctor(): Promise<DoctorReport>;
  /**
   * Open a terminal window running the bundled Copilot CLI's `login` command, so the
   * user can sign in without a globally installed `copilot`.
   */
  copilotSignIn(): Promise<CopilotSignInResult>;
  onStatusChanged(cb: (status: RecorderStatus) => void): () => void;
  narrationStatus(): Promise<NarrationStatus>;
  downloadNarrationModel(): Promise<NarrationActionResult>;
  transcribeNarration(sessionId: string): Promise<NarrationActionResult>;
  onNarrationStatusChanged(cb: (status: NarrationStatus) => void): () => void;
  /** Run the Copilot describer on a session (defaults to the last completed one). */
  analyze(sessionId?: string): Promise<AnalyzeResult>;
  /** Send NL feedback and re-analyze in the same multi-turn session. */
  analyzeFeedback(input: AnalysisFeedbackInput): Promise<AnalyzeResult>;
  /** Load the persisted analysis for a session, if any. */
  getAnalysis(sessionId: string): Promise<Analysis | null>;
  /** Edit the title/intent text directly (no re-analysis). */
  updateAnalysis(input: AnalysisEditInput): Promise<AnalyzeResult>;
  /** Abort an in-flight analysis. */
  cancelAnalysis(sessionId: string): Promise<{ ok: boolean }>;
  onAnalyzeProgress(cb: (progress: AnalyzeProgress) => void): () => void;
  /** All saved recordings, newest first, for the sessions library. */
  listSessions(): Promise<SessionSummary[]>;
  /** Permanently delete a saved recording and all its artifacts from disk. */
  deleteSession(sessionId: string): Promise<DeleteSessionResult>;
  /**
   * Package a single recording (its whole session folder plus a generated
   * diagnostics file) into a .zip the user picks a location for. The bundle
   * contains private capture data; the renderer warns before calling this.
   */
  exportDebugBundle(sessionId: string): Promise<DebugBundleResult>;
  /**
   * Propose (or refine) a skill from a recording's analysis. Pass `feedback` to
   * revise the current plan in the same multi-turn conversation.
   */
  buildSkill(input: SkillBuildInput): Promise<SkillPlanResult>;
  /**
   * Finalize the (user-edited) skill plan and place its SKILL.md. The edited plan the
   * user sees is authoritative — the body is written from exactly these values and steps.
   * `placement` picks the destination: `"install"` writes into the target agent's live
   * skills folder (Scout); `"export"` prompts for a folder and downloads it there (the
   * only option for Cowork). Defaults to `"install"`.
   */
  createSkill(sessionId: string, plan: SkillPlan, placement?: SkillPlacement): Promise<SkillCreateResult>;
  /** Load a previously built skill for a session, if any. */
  getSkill(sessionId: string): Promise<BuiltSkill | null>;
  /** Abort an in-flight build. */
  cancelSkill(sessionId: string): Promise<{ ok: boolean }>;
  /** Reveal an exported SKILL.md in the OS file manager. */
  /** Reveal a session's exported SKILL.md in the OS file manager. */
  revealSkill(sessionId: string): Promise<{ ok: boolean }>;
  onSkillProgress(cb: (progress: SkillBuildProgress) => void): () => void;
  /**
   * Propose (or refine) an automation from a recording's analysis. Pass `feedback`
   * to revise the current plan in the same multi-turn conversation.
   */
  buildAutomation(input: AutomationBuildInput): Promise<AutomationPlanResult>;
  /** Finalize the (user-edited) automation plan and export its importable bundle.
   *  The edited plan is authoritative — the bundle is built from it verbatim. */
  createAutomation(sessionId: string, plan: AutomationPlan): Promise<AutomationCreateResult>;
  /** Load a previously built automation for a session, if any. */
  getAutomation(sessionId: string): Promise<BuiltAutomation | null>;
  /** Abort an in-flight automation build. */
  cancelAutomation(sessionId: string): Promise<{ ok: boolean }>;
  /** Reveal a session's exported automation bundle in the OS file manager. */
  revealAutomation(sessionId: string): Promise<{ ok: boolean }>;
  onAutomationProgress(cb: (progress: AutomationBuildProgress) => void): () => void;
  /** Open (and focus) the Sessions library window, docked to the recorder. */
  openLibrary(): Promise<void>;
  /** Close the Sessions library window from within it. */
  closeLibrary(): Promise<void>;
  /** Resize the recording-controls window while an overlay panel is visible. */
  setRecordingControlsExpanded(expanded: boolean): Promise<void>;
}
