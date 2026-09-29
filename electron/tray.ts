import { Menu, Tray, nativeImage } from "electron";

import { message, type UiLocale } from "../common/locales";
import { trayIcon } from "./icons";
import type { RecorderController } from "./recorder/controller";

export interface AppTrayHandle {
  tray: Tray;
  rebuild(): void;
  destroy(): void;
}

/** Last-resort tray glyph drawn in code, used only if the icon assets are missing. */
function fallbackTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const x = i % size;
    const y = Math.floor(i / size);
    const inside = (x - c) ** 2 + (y - c) ** 2 <= r * r;
    buf[o] = 42;
    buf[o + 1] = 54;
    buf[o + 2] = 237;
    buf[o + 3] = inside ? 255 : 0;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export function createTray(
  recorder: RecorderController,
  startRecording: () => Promise<unknown>,
  stopRecording: () => Promise<unknown>,
  showRecorderWindow: () => void,
  showRecordingControls: () => void,
  locale: UiLocale,
): AppTrayHandle {
  const tray = new Tray(trayIcon() ?? fallbackTrayIcon());

  const rebuild = () => {
    const recording = recorder.state === "recording";
    tray.setToolTip(message(locale, "appName"));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: recording ? message(locale, "stopRecording") : message(locale, "startRecording"),
          click: () => void (recording ? stopRecording() : startRecording()),
        },
        { type: "separator" },
        {
          label: recording
            ? message(locale, "showRecordingControls")
            : message(locale, "showWindow"),
          click: () => {
            if (recording) {
              showRecordingControls();
              return;
            }
            showRecorderWindow();
          },
        },
        { label: message(locale, "quit"), role: "quit" },
      ]),
    );
  };

  const offStatus = recorder.onStatusChanged(rebuild);
  rebuild();
  return {
    tray,
    rebuild,
    destroy() {
      offStatus();
      tray.destroy();
    },
  };
}
