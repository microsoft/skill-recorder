import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

import {
  RECORDING_CONTROLS_SIZE,
  clampRecordingControlsBounds,
  initialRecordingControlsBounds,
  resizeRecordingControlsBounds,
} from "./recording-controls-bounds";
import { RECORDER_WINDOW_WIDTH } from "./recorder-window-sizing";
import { windowIcon } from "./icons";
export { fitRecorderHeight } from "./recorder-window-sizing";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Compact recording HUD — fixed width; height auto-fits its content (see
 *  `fitRecorderHeight`). The initial height is a sensible first paint before the
 *  renderer reports its true content height. */
const RECORDER = { width: RECORDER_WINDOW_WIDTH, height: 500 };
/** Library sizing bounds; actual width adapts to the space beside the recorder. */
const LIBRARY = { desiredWidth: 1140, minWidth: 720, floorWidth: 520, maxHeight: 820 };
const MARGIN = 12;
const GAP = 10;

type Bounds = { x: number; y: number; width: number; height: number };
let recordingControlsAnchor: { x: number; bottom: number } | null = null;

function loadRoute(win: BrowserWindow, hash?: string): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  } else {
    void win.loadFile(path.join(dirname, "..", "dist", "index.html"), hash ? { hash } : undefined);
  }
}

function registerDevelopmentDevToolsShortcut(win: BrowserWindow): void {
  if (process.platform !== "win32" || !process.env.VITE_DEV_SERVER_URL) return;

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "F12" || input.isAutoRepeat) return;
    event.preventDefault();
    win.webContents.toggleDevTools();
  });
}

export function createRecorderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: RECORDER.width,
    height: RECORDER.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Skill Recorder",
    icon: windowIcon(),
    backgroundColor: "#faf8f5",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  registerDevelopmentDevToolsShortcut(win);
  loadRoute(win);
  return win;
}

/** Always-on-top recording transport shown without stealing focus from the task. */
export function createRecordingControlsWindow(): BrowserWindow {
  let bounds: Bounds;
  if (recordingControlsAnchor) {
    const preferred = {
      x: recordingControlsAnchor.x,
      y: recordingControlsAnchor.bottom - RECORDING_CONTROLS_SIZE.collapsedHeight,
      width: RECORDING_CONTROLS_SIZE.width,
      height: RECORDING_CONTROLS_SIZE.collapsedHeight,
    };
    const display = screen.getDisplayMatching(preferred);
    bounds = clampRecordingControlsBounds(preferred, display.workArea);
  } else {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    bounds = initialRecordingControlsBounds(display.workArea);
  }
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    skipTaskbar: true,
    title: "Skill Recorder: Recording controls",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Supported platforms exclude this window from desktop capture; on older
  // systems Electron falls back to protecting its content.
  win.setContentProtection(true);
  const rememberPosition = () => {
    if (win.isDestroyed()) return;
    const current = win.getBounds();
    recordingControlsAnchor = { x: current.x, bottom: current.y + current.height };
  };
  win.on("move", rememberPosition);
  win.on("resize", rememberPosition);
  rememberPosition();
  loadRoute(win, "recording-controls");
  return win;
}

/** Resize a panel above the bar while preserving its on-screen bottom edge. */
export function setRecordingControlsExpanded(
  win: BrowserWindow,
  expanded: boolean,
): void {
  if (win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  win.setBounds(resizeRecordingControlsBounds(bounds, expanded, display.workArea), false);
}

/** Bring a dragged overlay back onto an available display. */
export function clampRecordingControlsWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  win.setBounds(clampRecordingControlsBounds(bounds, display.workArea), false);
}

/**
 * Lay the recorder and library out as an attached pair that is always fully
 * visible. The recorder keeps its place and the library docks to its right
 * whenever there's room; only when the right side is too tight do we slide the
 * recorder left (and, on very small displays, shrink the library) so the two
 * never overlap.
 */
function computeDock(recorder: BrowserWindow): { recorder: { x: number; y: number }; library: Bounds } {
  const rb = recorder.getBounds();
  const { workArea: wa } = screen.getDisplayMatching(rb);
  const recW = rb.width;
  const recH = rb.height;

  const libH = Math.min(LIBRARY.maxHeight, wa.height - MARGIN * 2);
  const pairTop = Math.max(
    wa.y + MARGIN,
    Math.min(rb.y, wa.y + wa.height - MARGIN - Math.max(recH, libH)),
  );

  let recX = rb.x;
  let libX = recX + recW + GAP;
  const rightRoom = wa.x + wa.width - MARGIN - libX;

  let libW: number;
  if (rightRoom >= LIBRARY.minWidth) {
    libW = Math.min(rightRoom, LIBRARY.desiredWidth);
  } else {
    const maxPairLibW = wa.width - MARGIN * 2 - recW - GAP;
    libW = Math.max(LIBRARY.floorWidth, Math.min(LIBRARY.desiredWidth, maxPairLibW));
    const totalW = recW + GAP + libW;
    recX = Math.max(wa.x + MARGIN, wa.x + wa.width - MARGIN - totalW);
    libX = recX + recW + GAP;
  }

  return {
    recorder: { x: Math.round(recX), y: Math.round(pairTop) },
    library: { x: Math.round(libX), y: Math.round(pairTop), width: Math.round(libW), height: Math.round(libH) },
  };
}

export function createLibraryWindow(recorder: BrowserWindow): BrowserWindow {
  const layout = computeDock(recorder);
  const win = new BrowserWindow({
    ...layout.library,
    minWidth: LIBRARY.floorWidth,
    minHeight: 480,
    show: false,
    title: "Skill Recorder: Sessions",
    icon: windowIcon(),
    backgroundColor: "#faf8f5",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  registerDevelopmentDevToolsShortcut(win);
  // Move the recorder and reveal the library together so the pair appears docked.
  win.once("ready-to-show", () => {
    if (!recorder.isDestroyed()) recorder.setPosition(layout.recorder.x, layout.recorder.y, false);
    win.show();
  });
  loadRoute(win, "library");
  return win;
}

/** Re-dock an already-open library beside the recorder and bring it forward. */
export function redockLibrary(recorder: BrowserWindow, library: BrowserWindow): void {
  if (library.isDestroyed() || recorder.isDestroyed()) return;
  const layout = computeDock(recorder);
  recorder.setPosition(layout.recorder.x, layout.recorder.y, false);
  library.setBounds(layout.library, false);
}
