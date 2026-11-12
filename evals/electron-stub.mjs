// Headless stand-in for the `electron` module so the describer/pipeline code can
// run under plain Node in the eval harness. The only real dependency in that code
// path is `app.getPath` inside session-store.ts, and the harness overrides the
// sessions root via SKILL_RECORDER_SESSIONS_DIR — so getPath is never actually
// called. Everything else is a benign no-op provided only to satisfy static
// `import { … } from "electron"` links in modules that might get pulled in.
import os from "node:os";
import path from "node:path";

const notAvailable = (name) => () => {
  throw new Error(`electron.${name} is not available in the headless eval runtime`);
};

export const app = {
  getPath: (name) => path.join(os.tmpdir(), "skill-recorder-eval", String(name ?? "userData")),
  getVersion: () => "0.0.0-eval",
  getName: () => "skill-recorder-eval",
  getAppPath: () => process.cwd(),
  on: () => app,
  whenReady: () => Promise.resolve(),
  quit: () => undefined,
};

export const ipcMain = { handle: () => undefined, on: () => undefined, removeHandler: () => undefined };
export const safeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "unknown",
  encryptString: notAvailable("safeStorage.encryptString"),
  decryptString: notAvailable("safeStorage.decryptString"),
};
export const globalShortcut = { register: () => false, unregisterAll: () => undefined };
export const clipboard = { readText: () => "", readImage: () => ({ isEmpty: () => true }), availableFormats: () => [] };
export const screen = { getPrimaryDisplay: notAvailable("screen.getPrimaryDisplay"), getDisplayMatching: notAvailable("screen.getDisplayMatching") };
export const desktopCapturer = { getSources: async () => [] };
export const nativeImage = { createEmpty: () => ({ isEmpty: () => true }), createFromPath: () => ({ isEmpty: () => true }) };

export class BrowserWindow {
  constructor() { throw new Error("electron.BrowserWindow is not available in the headless eval runtime"); }
}
export class Menu {}
export class Tray {
  constructor() { throw new Error("electron.Tray is not available in the headless eval runtime"); }
}

export default { app, ipcMain, globalShortcut, clipboard, screen, desktopCapturer, nativeImage, BrowserWindow, Menu, Tray };
