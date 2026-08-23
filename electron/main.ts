import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
} from "electron";

import { FULL_CAPTURE } from "../common/config";
import { IPC, type RecorderStatus, type StartResult } from "../common/ipc";
import type {
  SupportedShellId,
  TerminalActionResult,
  TerminalStatus,
} from "../common/terminal";
import { createCollectors } from "./collectors";
import { installCrashGuards } from "./crash-guards";
import { Describer } from "./describer/describer";
import { processSession } from "./pipeline";
import { registerIpc } from "./ipc";
import { createLogger } from "./logger";
import { NarrationManager } from "./narration/manager";
import { SensitiveModelManager } from "./sensitive/model-manager";
import { RecorderController } from "./recorder/controller";
import { RecordingPrivacySession } from "./recording-privacy";
import { deleteSession } from "./sessions";
import { SkillBuilder } from "./skillbuilder/builder";
import { AutomationBuilder } from "./automationbuilder/builder";
import { createTray } from "./tray";
import { dockIcon } from "./icons";
import { AudioRecorder } from "./audio/recorder";
import { TerminalSession } from "./terminal/session";
import { VideoRecorder } from "./video/recorder";
import { ScreenSourceService } from "./video/sources";
import {
  clampRecordingControlsWindow,
  createLibraryWindow,
  createRecorderWindow,
  createRecordingControlsWindow,
  createTerminalWindow,
  fitRecorderHeight,
  redockLibrary,
  setRecordingControlsExpanded,
} from "./window";

const log = createLogger("Main");

// Contain stray async failures so a lost stream error can't crash the main
// process (and the recording in progress). Registered before any window/IO work.
installCrashGuards(log);

/** Static red-dot tile used for the macOS Dock icon. */
const dock = dockIcon();

let recorderWindow: BrowserWindow | null = null;
let libraryWindow: BrowserWindow | null = null;
let recordingControlsWindow: BrowserWindow | null = null;
let terminalWindow: BrowserWindow | null = null;
let terminalWindowClosing = false;
let terminalSession: TerminalSession | null = null;
let terminalSessionId: string | null = null;
let recorderHome: Electron.Rectangle | null = null;
let controlsExpanded = false;
let quitReady = false;
let quitTask: Promise<void> | null = null;
let recordingStartPending = false;
const recordingPrivacy = new RecordingPrivacySession();
const narration = new NarrationManager((status) =>
  broadcast(IPC.narrationStatusChanged, status),
);
const sensitiveModels = new SensitiveModelManager((status) =>
  broadcast(IPC.sensitiveStatusChanged, status),
);
const microphones = new AudioRecorder((status) =>
  broadcast(IPC.microphoneSettingsChanged, status),
);
const screens = new ScreenSourceService((status) =>
  broadcast(IPC.screenSettingsChanged, status),
);

async function finishRecordedTerminal(): Promise<void> {
  const session = terminalSession;
  try {
    if (session) await session.finish();
  } catch (error) {
    session?.destroy();
    throw error;
  } finally {
    terminalSession = null;
    terminalSessionId = null;
    if (terminalWindow && !terminalWindow.isDestroyed()) {
      terminalWindowClosing = true;
      terminalWindow.destroy();
    }
    terminalWindow = null;
    terminalWindowClosing = false;
  }
}

const recorder = new RecorderController({
  resolveConfig: () => ({ ...FULL_CAPTURE }),
  buildCollectors: createCollectors,
  createVideoRecorder: () => new VideoRecorder(),
  createAudioRecorder: (onCaptureEnded) =>
    microphones.createSession(onCaptureEnded),
  terminalBusy: () =>
    terminalSession?.busyDetails() ?? { busy: false, command: null },
  finishTerminal: finishRecordedTerminal,
  deleteSession,
  postProcess: async (dir) => {
    await processSession(dir);
    try {
      await narration.transcribeIfCached(dir);
    } catch (err) {
      log.warn("Cached narration processing failed:", err);
    }
  },
});

async function startRecording(): Promise<StartResult> {
  if (recordingStartPending) {
    return { ok: false, error: "Recording is already starting." };
  }
  recordingStartPending = true;
  try {
    await Promise.all([
      microphones.whenSettingsSettled(),
      screens.whenSettingsSettled(),
    ]);
    const screenOptions = await screens.startOptions();
    return await recorder.start({
      ...microphones.startOptions(),
      ...screenOptions,
    });
  } finally {
    recordingStartPending = false;
  }
}

/** Send an event to every live window (recorder HUD + library, if open). */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const describer = new Describer((progress) => broadcast(IPC.analyzeProgress, progress));
const builder = new SkillBuilder((progress) => broadcast(IPC.skillProgress, progress));
const automationBuilder = new AutomationBuilder((progress) =>
  broadcast(IPC.automationProgress, progress),
);

/** Open, focus, and re-dock the Sessions library window (creating it lazily). */
function openLibrary(): void {
  if (recorder.state === "recording") return;
  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    redockLibrary(recorderWindow, libraryWindow);
    libraryWindow.show();
    libraryWindow.focus();
    return;
  }
  recorderHome = recorderWindow.getBounds();
  libraryWindow = createLibraryWindow(recorderWindow);
  libraryWindow.on("closed", () => {
    libraryWindow = null;
    // Return the recorder to where it sat before it made room for the library.
    if (recorderWindow && !recorderWindow.isDestroyed() && recorderHome) {
      recorderWindow.setBounds(recorderHome);
    }
    recorderHome = null;
    // Drop idle agent conversations now that the library is gone.
    void describer.evictIdle();
    void builder.evictIdle();
    void automationBuilder.evictIdle();
  });
}

function ensureRecordingControlsWindow(): BrowserWindow {
  if (recordingControlsWindow && !recordingControlsWindow.isDestroyed()) {
    return recordingControlsWindow;
  }
  controlsExpanded = false;
  recordingControlsWindow = createRecordingControlsWindow();
  recordingControlsWindow.on("closed", () => {
    recordingControlsWindow = null;
    controlsExpanded = false;
  });
  return recordingControlsWindow;
}

function ensureTerminalWindow(): BrowserWindow {
  if (terminalWindow && !terminalWindow.isDestroyed()) return terminalWindow;
  terminalWindowClosing = false;
  const win = createTerminalWindow();
  terminalWindow = win;
  win.on("close", (event) => {
    if (!terminalWindowClosing && recorder.state === "recording") {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (terminalWindow === win) terminalWindow = null;
  });
  return win;
}

function emptyTerminalStatus(): TerminalStatus {
  return {
    state: "closed",
    shell: null,
    integrationQuality: "none",
    busy: false,
    exitCode: null,
    error: null,
  };
}

async function openRecordedTerminal(): Promise<TerminalActionResult> {
  const active = recorder.activeSession();
  if (!active) {
    return { ok: false, error: "Open the recorded terminal while a recording is active." };
  }
  const win = ensureTerminalWindow();
  if (!terminalSession || terminalSessionId !== active.id) {
    terminalSession = new TerminalSession({
      sessionDir: active.dir,
      sessionStartedAt: active.startedAt,
      publishCommand: (payload) => {
        recorder.recordTerminalCommand(payload);
      },
    });
    terminalSessionId = active.id;
    terminalSession.onStatus((status) =>
      broadcast(IPC.terminalStatusChanged, status),
    );
    terminalSession.onOutput((data) => {
      if (terminalWindow && !terminalWindow.isDestroyed()) {
        terminalWindow.webContents.send(IPC.terminalOutput, data);
      }
    });
  }

  const reveal = () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    win.webContents.send(IPC.terminalStatusChanged, terminalSession?.status());
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", reveal);
  else reveal();

  const state = terminalSession.status().state;
  if (
    !win.webContents.isLoading() &&
    (state === "closed" || state === "exited" || state === "error")
  ) {
    return terminalSession.start();
  }
  return { ok: true };
}

async function requestStopRecording(): Promise<void> {
  const result = await recorder.stop();
  if (!result.requiresTerminalConfirmation) return;
  const win = ensureRecordingControlsWindow();
  showRecordingControls();
  const notify = () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.terminalFinishConfirmationRequested);
    }
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", notify);
  else notify();
}

function showRecordingControls(): void {
  const win = ensureRecordingControlsWindow();
  clampRecordingControlsWindow(win);
  if (!win.isVisible()) win.showInactive();
  win.moveTop();
}

function showRecorderWindow(): BrowserWindow {
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    recorderWindow = createRecorderWindow();
  }
  recorderWindow.show();
  recorderWindow.focus();
  return recorderWindow;
}

function showRecordingPrivacyWarning(): void {
  const win = showRecorderWindow();
  const notify = () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.recordingPrivacyWarningRequested);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", notify);
  } else {
    notify();
  }
}

async function requestStartRecording(): Promise<StartResult> {
  if (recordingPrivacy.startDecision() === "start") return startRecording();
  showRecordingPrivacyWarning();
  return { ok: false, privacyWarningRequired: true };
}

/** Keep the full HUD and compact overlay mutually exclusive. */
function syncRecordingWindows(status: RecorderStatus): void {
  if (status.state === "recording") {
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.close();
    if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.hide();
    showRecordingControls();
    return;
  }
  // A start emits an idle/starting status before the session folder exists.
  if (status.transition === "starting") return;

  if (recordingControlsWindow && !recordingControlsWindow.isDestroyed()) {
    const controls = recordingControlsWindow;
    if (controlsExpanded) {
      setRecordingControlsExpanded(controls, false);
      controlsExpanded = false;
    }
    controls.hide();
    // Let an overlay-originated stop/discard IPC reply reach its renderer before
    // tearing that renderer down. A recording restarted in the same turn reuses it.
    setTimeout(() => {
      if (
        recorder.state === "idle" &&
        recordingControlsWindow === controls &&
        !controls.isDestroyed()
      ) {
        controls.destroy();
        recordingControlsWindow = null;
      }
    }, 500);
  }
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    const wasHidden = !recorderWindow.isVisible();
    recorderWindow.show();
    if (wasHidden) recorderWindow.focus();
  }
}

function clampControlsToDisplay(): void {
  if (recordingControlsWindow && !recordingControlsWindow.isDestroyed()) {
    clampRecordingControlsWindow(recordingControlsWindow);
  }
}

app.whenReady().then(async () => {
  if (process.platform === "win32") Menu.setApplicationMenu(null);
  if (dock && app.dock) app.dock.setIcon(dock);

  narration.initialize();
  try {
    await microphones.initialize();
  } catch (error) {
    log.warn(
      "Microphone service initialization failed:",
      error instanceof Error ? error.message : error,
    );
  }
  try {
    await screens.initialize();
  } catch (error) {
    log.warn(
      "Screen source initialization failed:",
      error instanceof Error ? error.message : error,
    );
  }
  registerIpc(
    recorder,
    describer,
    builder,
    automationBuilder,
    narration,
    microphones,
    screens,
    sensitiveModels,
    () => recordingStartPending,
    (sender) => {
      const controls = recordingControlsWindow;
      return Boolean(
        controls && !controls.isDestroyed() && sender === controls.webContents,
      );
    },
  );
  sensitiveModels.initialize();
  ipcMain.handle(IPC.start, () => requestStartRecording());
  ipcMain.handle(IPC.startConfirmed, () => startRecording());
  ipcMain.handle(IPC.recordingPrivacyReviewed, () => recordingPrivacy.markReviewed());
  log.info("Capture: recording all sources");

  ipcMain.handle(IPC.openLibrary, () => openLibrary());
  ipcMain.handle(IPC.closeLibrary, () => {
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.close();
  });
  ipcMain.handle(IPC.terminalOpen, (event) => {
    const controls = recordingControlsWindow;
    if (!controls || controls.isDestroyed() || event.sender !== controls.webContents) {
      return { ok: false, error: "The recorded terminal can only be opened from the recording bar." };
    }
    return openRecordedTerminal();
  });
  ipcMain.handle(IPC.terminalReady, (event) => {
    const win = terminalWindow;
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      !terminalSession
    ) {
      return { ok: false, error: "The recorded terminal is unavailable." };
    }
    const state = terminalSession.status().state;
    if (state === "closed" || state === "exited" || state === "error") {
      return terminalSession.start();
    }
    return { ok: true };
  });
  ipcMain.handle(IPC.terminalStatus, () =>
    terminalSession?.status() ?? emptyTerminalStatus(),
  );
  ipcMain.handle(IPC.terminalShells, () => [...(terminalSession?.shells ?? [])]);
  ipcMain.handle(IPC.terminalSwitchShell, (event, shellId: SupportedShellId) => {
    const win = terminalWindow;
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      !terminalSession
    ) {
      return { ok: false, error: "The recorded terminal is unavailable." };
    }
    return terminalSession.switchShell(shellId);
  });
  ipcMain.on(IPC.terminalInput, (event, data: unknown) => {
    const win = terminalWindow;
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      typeof data !== "string" ||
      data.length > 1_000_000
    ) {
      return;
    }
    terminalSession?.write(data);
  });
  ipcMain.on(
    IPC.terminalResize,
    (event, size: { columns?: unknown; rows?: unknown } | null) => {
      const win = terminalWindow;
      if (
        !win ||
        win.isDestroyed() ||
        event.sender !== win.webContents ||
        !size ||
        typeof size.columns !== "number" ||
        typeof size.rows !== "number"
      ) {
        return;
      }
      terminalSession?.resize(size.columns, size.rows);
    },
  );
  ipcMain.handle(IPC.terminalHide, (event) => {
    const win = terminalWindow;
    if (win && !win.isDestroyed() && event.sender === win.webContents) win.hide();
  });
  ipcMain.handle(IPC.recordingControlsExpanded, (event, expanded: boolean) => {
    const win = recordingControlsWindow;
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      typeof expanded !== "boolean" ||
      recorder.state !== "recording"
    ) {
      return;
    }
    controlsExpanded = expanded;
    setRecordingControlsExpanded(win, expanded);
  });
  ipcMain.on(IPC.fitRecorderHeight, (event, height: unknown) => {
    const win = recorderWindow;
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      typeof height !== "number"
    ) {
      return;
    }
    fitRecorderHeight(win, height);
  });

  recorder.onStatusChanged((status) => {
    broadcast(IPC.statusChanged, status);
    syncRecordingWindows(status);
  });
  recorderWindow = createRecorderWindow();

  const handleDisplayChange = () => {
    clampControlsToDisplay();
    void screens.refresh();
  };
  screen.on("display-added", handleDisplayChange);
  screen.on("display-removed", handleDisplayChange);
  screen.on("display-metrics-changed", handleDisplayChange);

  try {
    createTray(
      recorder,
      requestStartRecording,
      requestStopRecording,
      showRecorderWindow,
      showRecordingControls,
    );
  } catch (err) {
    log.warn("Tray unavailable:", err);
  }

  const toggle = () => {
    const status = recorder.status();
    if (status.transition !== "none") return;
    void (status.state === "recording" ? requestStopRecording() : requestStartRecording());
  };
  if (!globalShortcut.register("CommandOrControl+Shift+R", toggle)) {
    log.warn("Global shortcut registration failed");
  }

  app.on("activate", () => {
    if (recorder.state === "recording") {
      showRecordingControls();
      return;
    }
    showRecorderWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitTask) return;
  quitTask = (async () => {
    const terminal = terminalSession?.busyDetails() ?? { busy: false, command: null };
    if (terminal.busy) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Keep recording", "Close terminal and quit"],
        defaultId: 0,
        cancelId: 0,
        message: "A terminal command is still running.",
        detail: terminal.command
          ? `Closing Skill Recorder will interrupt: ${terminal.command}`
          : "Closing Skill Recorder will interrupt the active terminal session.",
      });
      if (response === 0) return;
    }
    recorder.beginShutdown();
    // stop() is serialized behind any start/mic/discard operation already in
    // flight, and is a harmless "Not recording" result when the app is idle.
    await recorder.stop(terminal.busy);
    await recorder.whenProcessed();
    quitReady = true;
    app.quit();
  })()
    .catch((error) => {
      log.warn("graceful shutdown failed:", error);
      quitReady = true;
      app.quit();
    })
    .finally(() => {
      quitTask = null;
    });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void describer.dispose();
  void builder.dispose();
  void automationBuilder.dispose();
  microphones.dispose();
  void sensitiveModels.dispose();
});
