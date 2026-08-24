import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import os from "node:os";
import path from "node:path";

import type {
  AnalysisEditInput,
  AnalysisFeedbackInput,
  AnalyzeResult,
  AutomationBuildInput,
  AutomationCreateResult,
  AutomationPlanResult,
  DebugBundleResult,
  DeleteSessionResult,
  MicrophoneSettingsResult,
  ScreenSettingsResult,
  SkillBuildInput,
  SkillCreateResult,
  SkillPlacement,
  SkillPlanResult,
} from "../common/ipc";
import { IPC } from "../common/ipc";
import type { AutomationPlan } from "../common/automation";
import type { NarrationLanguage } from "../common/narration";
import type { SensitiveReport } from "../common/sensitive";
import type { SkillPlan } from "../common/skill";
import { AutomationBuilder, loadPersistedAutomation } from "./automationbuilder/builder";
import { openCopilotSignIn } from "./copilot-signin";
import { buildDebugInfo, writeDebugBundle } from "./debug-bundle";
import { Describer, loadPersistedAnalysis } from "./describer/describer";
import type { RedactionContext } from "./describer/tools";
import { runDoctor } from "./doctor";
import { createLogger } from "./logger";
import type { AudioRecorder } from "./audio/recorder";
import type { NarrationManager } from "./narration/manager";
import type { RecorderController } from "./recorder/controller";
import type { ScreenSourceService } from "./video/sources";
import { isValidSessionId } from "./recorder/session-store";
import {
  INACTIVE_FRAME_REDACTOR,
  OcrFrameRedactor,
  WITHHOLD_FRAME_REDACTOR,
} from "./sensitive/frame-redact";
import type { SensitiveModelManager } from "./sensitive/model-manager";
import { buildRedactor, loadSensitiveReport, saveSensitiveReport, scanSession } from "./sensitive/scanner";
import { deleteSession, listSessions } from "./sessions";
import { loadPersistedSkill, SkillBuilder, type SkillTarget } from "./skillbuilder/builder";

const log = createLogger("IPC");

/** Wire the renderer-facing invoke channels to the recorder, describer, builders + doctor. */
export function registerIpc(
  recorder: RecorderController,
  describer: Describer,
  builder: SkillBuilder,
  automationBuilder: AutomationBuilder,
  narration: NarrationManager,
  microphones: AudioRecorder,
  screens: ScreenSourceService,
  sensitiveModels: SensitiveModelManager,
  isRecordingStartPending: () => boolean,
): void {
  ipcMain.handle(IPC.stop, () => recorder.stop());
  ipcMain.handle(IPC.discard, () => recorder.discard());
  ipcMain.handle(IPC.microphone, (_event, enabled: boolean) =>
    recorder.setMicrophoneEnabled(enabled, microphones.effectiveDeviceId()),
  );
  ipcMain.handle(IPC.microphoneSettings, () => microphones.settings());
  ipcMain.handle(
    IPC.microphoneNarration,
    async (_event, enabled: boolean): Promise<MicrophoneSettingsResult> => {
      if (typeof enabled !== "boolean") {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Invalid narration preference.",
        };
      }
      if (recorder.state === "recording" || isRecordingStartPending()) {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Choose the next recording's narration state after this recording ends.",
        };
      }
      return microphones.setNarrationEnabled(enabled);
    },
  );
  ipcMain.handle(IPC.screenSettings, () => screens.refresh());
  ipcMain.handle(
    IPC.screenSource,
    async (_event, sourceId: string): Promise<ScreenSettingsResult> => {
      if (typeof sourceId !== "string" || !sourceId) {
        return {
          ok: false,
          status: screens.settings(),
          error: "Invalid screen selection.",
        };
      }
      if (recorder.state === "recording") {
        return {
          ok: false,
          status: screens.settings(),
          error: "Choose the next recording's screen after this recording ends.",
        };
      }
      return screens.selectSource(sourceId);
    },
  );
  ipcMain.handle(
    IPC.microphoneDevice,
    async (_event, deviceId: string): Promise<MicrophoneSettingsResult> => {
      if (typeof deviceId !== "string" || !deviceId) {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Invalid microphone selection.",
        };
      }
      const previousDeviceId = microphones.effectiveDeviceId();
      const selected = await microphones.selectDevice(deviceId);
      if (
        !selected.ok ||
        recorder.status().microphone.state !== "on" ||
        microphones.effectiveDeviceId() === previousDeviceId
      ) {
        return selected;
      }
      const switched = await recorder.setMicrophoneDevice(
        microphones.effectiveDeviceId(),
      );
      if (!switched.ok) {
        return {
          ok: false,
          status: microphones.settings(),
          error: switched.error ?? "Could not switch microphones.",
        };
      }
      return { ok: true, status: microphones.settings() };
    },
  );
  ipcMain.handle(IPC.narrationLanguage, (_event, language: NarrationLanguage) =>
    recorder.setNarrationLanguage(language),
  );
  ipcMain.handle(IPC.status, () => recorder.status());
  ipcMain.handle(IPC.marker, (_event, note: string) => recorder.marker(note));
  ipcMain.handle(IPC.doctor, () => runDoctor());
  ipcMain.handle(IPC.copilotSignIn, () => openCopilotSignIn());
  ipcMain.handle(IPC.narrationStatus, () => narration.status());
  ipcMain.handle(IPC.narrationDownload, () => narration.downloadModel());
  ipcMain.handle(IPC.narrationTranscribe, (_event, sessionId: string) =>
    narration.transcribeSession(sessionId),
  );

  const resolveSessionId = (sessionId?: string): string | null => {
    if (sessionId) return sessionId;
    const dir = recorder.lastSessionDir();
    return dir ? path.basename(dir) : null;
  };

  ipcMain.handle(IPC.sensitiveModelStatus, () => sensitiveModels.status());
  ipcMain.handle(IPC.sensitiveSetAdvanced, (_event, enabled: boolean) => {
    if (typeof enabled !== "boolean") return { ok: false, error: "Invalid preference." };
    return sensitiveModels.setAdvanced(enabled);
  });
  ipcMain.handle(IPC.sensitiveDownloadModels, () => sensitiveModels.downloadModels());

  /**
   * Run the on-device pre-send scan and build the redaction context threaded into
   * the describer. Gated by the single protection opt-out (on by default): when it
   * is on, the text layers (secretlint + structured PII, which need no model) mask
   * the outgoing text and the frame-OCR layer blurs on-screen matches once its model
   * is ready; when the user has opted out, nothing is scanned and raw text + frames
   * are sent. Non-blocking: a scan failure still lets analysis run — text goes out
   * unmasked but frames are withheld so an error can't leak on-screen secrets.
   */
  const buildRedaction = async (
    sessionId: string,
  ): Promise<{ redaction: RedactionContext; report?: SensitiveReport }> => {
    // Protection is a single opt-out covering BOTH layers: masking secrets/PII in the
    // outgoing text AND blurring them in screen images. On by default; when the user
    // turns it off they've accepted sending the recording unredacted (better analysis
    // fidelity, no safety net), so we scan nothing and serve raw text + frames.
    if (!sensitiveModels.isAdvancedEnabled()) {
      return { redaction: { redactText: (t) => t, frameRedactor: INACTIVE_FRAME_REDACTOR } };
    }
    try {
      const { report, values } = await scanSession(sessionId);
      const redactText = buildRedactor(values);
      // Blur on-screen matches in frames too. If the OCR model is still provisioning
      // (typically a fresh first run) wait briefly for it rather than dropping frames;
      // only withhold if it can't be made ready in time (so Analyze never hangs, e.g.
      // offline).
      await sensitiveModels.ensureReady();
      const frameRedactor = new OcrFrameRedactor({ ocr: sensitiveModels.getOcr(), knownValues: values });
      return { redaction: { redactText, frameRedactor }, report };
    } catch (err) {
      log.warn("sensitive scan failed; proceeding without text redaction:", err instanceof Error ? err.message : err);
      // Protection is on but the scan threw: we have no values to mask text with, but we
      // must NOT serve raw frames, so withhold them so a scan error can't leak on-screen
      // secrets.
      return {
        redaction: { redactText: (t) => t, frameRedactor: WITHHOLD_FRAME_REDACTOR },
      };
    }
  };

  /**
   * Fold the frame-blur tally (known only after the describer has pulled frames)
   * into the pre-send text report, and decide whether there's anything worth
   * surfacing. Returns undefined when protection was off/failed or nothing was
   * hidden, so the UI shows a review only when it has something to say.
   */
  const summarizeProtection = (
    report: SensitiveReport | undefined,
    redaction: RedactionContext,
  ): SensitiveReport | undefined => {
    if (!report) return undefined;
    const { framesBlurred, regionsBlurred } = redaction.frameRedactor?.stats ?? {
      framesBlurred: 0,
      regionsBlurred: 0,
    };
    const images = regionsBlurred > 0 ? { framesBlurred, regionsBlurred } : undefined;
    if (report.totalFindings === 0 && !images) return undefined;
    return images ? { ...report, images } : report;
  };

  ipcMain.handle(
    IPC.analyze,
    async (_event, sessionId?: string): Promise<AnalyzeResult> => {
      const id = resolveSessionId(sessionId);
      if (!id) return { ok: false, error: "No completed session to analyze yet." };
      if (!isValidSessionId(id)) return { ok: false, error: "Unknown session." };
      // Transcribe any recorded voice first so analysis never silently runs without
      // the user's spoken intent. Downloads the model on first use. Best-effort: a
      // failure here falls through to analyzing without voice (the error is surfaced
      // via the narration status affordance and the audio stays saved).
      await narration.ensureTranscribedForAnalysis(id);
      // On-device pre-send redaction (non-blocking): mask secrets/credentials/PII in
      // every outgoing text field — and, under Advanced protection, blur on-screen
      // text in frames — before anything reaches GitHub Copilot. Analysis always
      // proceeds; the (raw-value-free) report is returned purely for a UI summary.
      const { redaction, report } = await buildRedaction(id);
      try {
        const analysis = await describer.analyze(id, redaction);
        const review = summarizeProtection(report, redaction);
        saveSensitiveReport(id, review);
        return { ok: true, analysis, review };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("analyze failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(
    IPC.analyzeFeedback,
    async (_event, input: AnalysisFeedbackInput): Promise<AnalyzeResult> => {
      if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
      // Re-scan + rebind the redactor so the feedback round stays masked too.
      const { redaction, report } = await buildRedaction(input.sessionId);
      try {
        const analysis = await describer.feedback(
          input.sessionId,
          { overall: input.overall, steps: input.steps ?? [] },
          redaction,
        );
        const review = summarizeProtection(report, redaction);
        saveSensitiveReport(input.sessionId, review);
        return { ok: true, analysis, review };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("feedback failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.getAnalysis, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedAnalysis(sessionId) : null,
  );

  ipcMain.handle(IPC.sensitiveGetReport, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadSensitiveReport(sessionId) : null,
  );

  ipcMain.handle(IPC.updateAnalysis, async (_event, input: AnalysisEditInput): Promise<AnalyzeResult> => {
    if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const analysis = await describer.edit(input.sessionId, {
        title: input.title,
        intent: input.intent,
        steps: input.steps,
      });
      return { ok: true, analysis };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("update failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(IPC.cancelAnalysis, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await describer.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.listSessions, () => listSessions());

  ipcMain.handle(IPC.deleteSession, async (_event, sessionId: string): Promise<DeleteSessionResult> => {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    if (recorder.status().sessionId === sessionId) {
      return { ok: false, error: "You can't delete a recording while it's still in progress." };
    }
    if (describer.isAnalyzing(sessionId)) {
      return { ok: false, error: "This recording is being analyzed. Cancel that first, then delete." };
    }
    if (narration.isBusyWith(sessionId)) {
      return { ok: false, error: "This recording is being transcribed. Wait for that to finish before deleting it." };
    }
    if (builder.isBuilding(sessionId)) {
      return { ok: false, error: "This recording is being turned into a skill. Cancel that first, then delete." };
    }
    if (automationBuilder.isBuilding(sessionId)) {
      return {
        ok: false,
        error: "This recording is being turned into an automation. Cancel that first, then delete.",
      };
    }
    try {
      await describer.forget(sessionId); // release any idle agent holding the folder
      await builder.forget(sessionId);
      await automationBuilder.forget(sessionId);
      await deleteSession(sessionId);
      recorder.forgetSession(sessionId); // clear the "last completed" pointer if it was this one
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("delete failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(
    IPC.exportDebugBundle,
    async (event, sessionId: string): Promise<DebugBundleResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      // The session folder is still being written while it records; refuse to zip
      // a moving target. Analyzing/building are read-only, so those are allowed.
      if (recorder.status().sessionId === sessionId) {
        return {
          ok: false,
          error: "You can't download details while this recording is still in progress.",
        };
      }
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const opts: SaveDialogOptions = {
        title: "Download session details",
        defaultPath: path.join(
          os.homedir(),
          "Downloads",
          `skill-recorder-debug-${sessionId}.zip`,
        ),
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      try {
        await writeDebugBundle(sessionId, result.filePath, buildDebugInfo(sessionId));
        shell.showItemInFolder(result.filePath); // hand the file to the user to attach
        return { ok: true, path: result.filePath };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("debug bundle failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.buildSkill, async (_event, input: SkillBuildInput): Promise<SkillPlanResult> => {
    if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const plan = await builder.build(input);
      return { ok: true, plan };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("build skill failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(
    IPC.createSkill,
    async (
      event,
      sessionId: string,
      plan?: SkillPlan,
      placement: SkillPlacement = "install",
    ): Promise<SkillCreateResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      try {
        let target: SkillTarget = { kind: "install" };
        if (placement === "export") {
          // Export == download: let the user pick a destination folder; we drop a
          // ready-to-use <name>/SKILL.md inside it. A dismissed dialog is a cancel, not an error.
          const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
          const opts: OpenDialogOptions = {
            title: "Export skill to folder",
            defaultPath: path.join(os.homedir(), "Downloads"),
            properties: ["openDirectory", "createDirectory"],
          };
          const result = win
            ? await dialog.showOpenDialog(win, opts)
            : await dialog.showOpenDialog(opts);
          if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
          target = { kind: "export", dir: result.filePaths[0] };
        }
        const { skill, path: file } = await builder.create(sessionId, plan, target);
        return { ok: true, skill, path: file, placement };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("create skill failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.getSkill, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedSkill(sessionId) : null,
  );

  ipcMain.handle(IPC.cancelSkill, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await builder.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.revealSkill, (_event, sessionId: string) => {
    if (!isValidSessionId(sessionId)) return { ok: false };
    const skill = loadPersistedSkill(sessionId);
    if (skill?.exportedPath) shell.showItemInFolder(skill.exportedPath);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.buildAutomation,
    async (_event, input: AutomationBuildInput): Promise<AutomationPlanResult> => {
      if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
      try {
        const plan = await automationBuilder.build(input);
        return { ok: true, plan };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("build automation failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.createAutomation, async (_event, sessionId: string, plan?: AutomationPlan): Promise<AutomationCreateResult> => {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const { automation, path: file } = await automationBuilder.create(sessionId, plan);
      return { ok: true, automation, path: file };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("create automation failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(IPC.getAutomation, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedAutomation(sessionId) : null,
  );

  ipcMain.handle(IPC.cancelAutomation, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await automationBuilder.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.revealAutomation, (_event, sessionId: string) => {
    if (!isValidSessionId(sessionId)) return { ok: false };
    const automation = loadPersistedAutomation(sessionId);
    if (automation?.exportedPath) shell.showItemInFolder(automation.exportedPath);
    return { ok: true };
  });
}
