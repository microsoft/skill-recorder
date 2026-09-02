/**
 * English message catalogue — the source language.
 *
 * This object is the contract: `MessageKey` is derived from it, so every other
 * locale is type-checked against these keys and a `t()` call with an unknown
 * key fails the build. Keys are `<surface>.<element>`; `{name}` marks an
 * interpolated value.
 */
export const en = {
  "settings.appLanguage.label": "App language",
  "settings.appLanguage.title": "Language of the app's own interface",

  "controls.capture.capturing": "Capturing",
  "controls.capture.starting": "Starting",
  "controls.capture.saving": "Saving",
  "controls.capture.discarding": "Discarding",

  "controls.microphone.systemDefault": "System default",
  "controls.microphone.heading": "Microphone",
  "controls.microphone.choose": "Choose microphone",
  "controls.microphone.group": "Audio input",
  "controls.microphone.selected": "Selected",
  "controls.microphone.using": "Using {device}",
  "controls.microphone.next": "Next: {device}",
  "controls.microphone.on": "On",
  "controls.microphone.off": "Off",
  "controls.microphone.starting": "Starting",
  "controls.microphone.stopping": "Stopping",
  "controls.microphone.retry": "Retry",
  "controls.microphone.muteAria": "Mute {device}. Narration is transcribed in {language}.",
  "controls.microphone.unmuteAria": "Unmute {device} for {language} narration",
  "controls.microphone.retryAria": "Retry microphone. {error}",
  "controls.microphone.muteTitle": "Mute {device} · {language} transcript",
  "controls.microphone.unmuteTitle": "Unmute {device} · {language} transcript",

  "controls.terminal.label": "Terminal",
  "controls.terminal.opening": "Opening",
  "controls.terminal.title": "Open a terminal captured only with this recording",
  "controls.terminal.openAria": "Open recorded terminal",
  "controls.terminal.focusAria": "Focus recorded terminal. {state}",

  "controls.discard.action": "Discard",
  "controls.discard.title": "Discard this recording?",
  "controls.discard.description":
    "Screen video, activity, recorded-terminal output, and voice segments will be permanently deleted.",
  "controls.discard.keep": "Keep recording",
  "controls.discard.confirm": "Discard recording",
  "controls.discard.pending": "Discarding...",

  "controls.terminalConfirm.title": "A terminal command is still running",
  "controls.terminalConfirm.description":
    "Closing the recording will stop the command and save its output as interrupted.",
  "controls.terminalConfirm.discard": "Close terminal and discard",
  "controls.terminalConfirm.save": "Close terminal and save",

  "controls.done.action": "Done",
  "controls.done.pending": "Saving...",

  "controls.error.microphoneChange": "Could not change the microphone.",
  "controls.error.microphoneSwitch": "Could not switch microphones.",
  "controls.error.stop": "Could not stop the recording.",
  "controls.error.discard": "Could not discard the recording.",
} as const;

export type MessageKey = keyof typeof en;
