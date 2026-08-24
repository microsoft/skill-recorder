// Preload bridge — CommonJS on purpose (runs in the renderer's isolated world).
// Keep channel strings in sync with common/ipc.ts.
const { contextBridge, ipcRenderer } = require("electron");

const IPC = {
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
  screenSettings: "screen:settings",
  screenSource: "screen:source",
  screenSettingsChanged: "screen:settings-changed",
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
  sensitiveModelStatus: "sensitive:status",
  sensitiveSetAdvanced: "sensitive:set-advanced",
  sensitiveDownloadModels: "sensitive:download-models",
  sensitiveStatusChanged: "sensitive:status-changed",
  sensitiveGetReport: "sensitive:get-report",
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
  fitRecorderHeight: "ui:fit-recorder-height",
};

let recordingPrivacyWarningPending = false;
let recordingPrivacyWarningCallback = null;
ipcRenderer.on(IPC.recordingPrivacyWarningRequested, () => {
  if (recordingPrivacyWarningCallback) {
    recordingPrivacyWarningCallback();
    return;
  }
  recordingPrivacyWarningPending = true;
});

contextBridge.exposeInMainWorld("skillRecorder", {
  start: () => ipcRenderer.invoke(IPC.start),
  confirmStart: () => ipcRenderer.invoke(IPC.startConfirmed),
  markRecordingPrivacyReviewed: () => ipcRenderer.invoke(IPC.recordingPrivacyReviewed),
  onRecordingPrivacyWarningRequested: (cb) => {
    recordingPrivacyWarningCallback = cb;
    if (recordingPrivacyWarningPending) {
      recordingPrivacyWarningPending = false;
      cb();
    }
    return () => {
      if (recordingPrivacyWarningCallback === cb) recordingPrivacyWarningCallback = null;
    };
  },
  stop: () => ipcRenderer.invoke(IPC.stop),
  discard: () => ipcRenderer.invoke(IPC.discard),
  setMicrophoneEnabled: (enabled) => ipcRenderer.invoke(IPC.microphone, enabled),
  setNarrationLanguage: (language) => ipcRenderer.invoke(IPC.narrationLanguage, language),
  microphoneSettings: () => ipcRenderer.invoke(IPC.microphoneSettings),
  setNarrationEnabled: (enabled) => ipcRenderer.invoke(IPC.microphoneNarration, enabled),
  selectMicrophone: (deviceId) => ipcRenderer.invoke(IPC.microphoneDevice, deviceId),
  onMicrophoneSettingsChanged: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on(IPC.microphoneSettingsChanged, listener);
    return () => ipcRenderer.removeListener(IPC.microphoneSettingsChanged, listener);
  },
  screenSettings: () => ipcRenderer.invoke(IPC.screenSettings),
  selectScreen: (sourceId) => ipcRenderer.invoke(IPC.screenSource, sourceId),
  onScreenSettingsChanged: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on(IPC.screenSettingsChanged, listener);
    return () => ipcRenderer.removeListener(IPC.screenSettingsChanged, listener);
  },
  status: () => ipcRenderer.invoke(IPC.status),
  marker: (note) => ipcRenderer.invoke(IPC.marker, note),
  doctor: () => ipcRenderer.invoke(IPC.doctor),
  copilotSignIn: () => ipcRenderer.invoke(IPC.copilotSignIn),
  onStatusChanged: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on(IPC.statusChanged, listener);
    return () => ipcRenderer.removeListener(IPC.statusChanged, listener);
  },
  narrationStatus: () => ipcRenderer.invoke(IPC.narrationStatus),
  downloadNarrationModel: () => ipcRenderer.invoke(IPC.narrationDownload),
  transcribeNarration: (sessionId) => ipcRenderer.invoke(IPC.narrationTranscribe, sessionId),
  onNarrationStatusChanged: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on(IPC.narrationStatusChanged, listener);
    return () => ipcRenderer.removeListener(IPC.narrationStatusChanged, listener);
  },
  sensitiveModelStatus: () => ipcRenderer.invoke(IPC.sensitiveModelStatus),
  setAdvancedProtection: (enabled) => ipcRenderer.invoke(IPC.sensitiveSetAdvanced, enabled),
  downloadSensitiveModels: () => ipcRenderer.invoke(IPC.sensitiveDownloadModels),
  onSensitiveModelStatusChanged: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on(IPC.sensitiveStatusChanged, listener);
    return () => ipcRenderer.removeListener(IPC.sensitiveStatusChanged, listener);
  },
  getSensitiveReport: (sessionId) => ipcRenderer.invoke(IPC.sensitiveGetReport, sessionId),
  analyze: (sessionId) => ipcRenderer.invoke(IPC.analyze, sessionId),
  analyzeFeedback: (input) => ipcRenderer.invoke(IPC.analyzeFeedback, input),
  getAnalysis: (sessionId) => ipcRenderer.invoke(IPC.getAnalysis, sessionId),
  updateAnalysis: (input) => ipcRenderer.invoke(IPC.updateAnalysis, input),
  cancelAnalysis: (sessionId) => ipcRenderer.invoke(IPC.cancelAnalysis, sessionId),
  onAnalyzeProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on(IPC.analyzeProgress, listener);
    return () => ipcRenderer.removeListener(IPC.analyzeProgress, listener);
  },
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  exportDebugBundle: (sessionId) => ipcRenderer.invoke(IPC.exportDebugBundle, sessionId),
  buildSkill: (input) => ipcRenderer.invoke(IPC.buildSkill, input),
  createSkill: (sessionId, plan, placement) => ipcRenderer.invoke(IPC.createSkill, sessionId, plan, placement),
  getSkill: (sessionId) => ipcRenderer.invoke(IPC.getSkill, sessionId),
  cancelSkill: (sessionId) => ipcRenderer.invoke(IPC.cancelSkill, sessionId),
  revealSkill: (sessionId) => ipcRenderer.invoke(IPC.revealSkill, sessionId),
  onSkillProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on(IPC.skillProgress, listener);
    return () => ipcRenderer.removeListener(IPC.skillProgress, listener);
  },
  buildAutomation: (input) => ipcRenderer.invoke(IPC.buildAutomation, input),
  createAutomation: (sessionId, plan) => ipcRenderer.invoke(IPC.createAutomation, sessionId, plan),
  getAutomation: (sessionId) => ipcRenderer.invoke(IPC.getAutomation, sessionId),
  cancelAutomation: (sessionId) => ipcRenderer.invoke(IPC.cancelAutomation, sessionId),
  revealAutomation: (sessionId) => ipcRenderer.invoke(IPC.revealAutomation, sessionId),
  onAutomationProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on(IPC.automationProgress, listener);
    return () => ipcRenderer.removeListener(IPC.automationProgress, listener);
  },
  openLibrary: () => ipcRenderer.invoke(IPC.openLibrary),
  closeLibrary: () => ipcRenderer.invoke(IPC.closeLibrary),
  setRecordingControlsExpanded: (expanded) =>
    ipcRenderer.invoke(IPC.recordingControlsExpanded, expanded),
  fitRecorderHeight: (height) => ipcRenderer.send(IPC.fitRecorderHeight, height),
});
