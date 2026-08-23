const RECORDER_MIN_HEIGHT = 320;
const RECORDER_MAX_HEIGHT = 720;
export const RECORDER_WINDOW_WIDTH = 400;

export interface RecorderWindowSizingTarget {
  isDestroyed(): boolean;
  getContentSize(): number[];
  getSize(): number[];
  setSize(width: number, height: number, animate?: boolean): void;
}

/**
 * Fit the recorder to its rendered content while enforcing its fixed outer width.
 * Programmatic setSize works on non-resizable BrowserWindows; toggling resizability
 * changes the Windows frame width and creates a resize-observer feedback loop.
 */
export function fitRecorderHeight(
  win: RecorderWindowSizingTarget,
  contentHeight: number,
): void {
  if (win.isDestroyed() || !Number.isFinite(contentHeight)) return;

  const targetContentHeight = Math.round(
    Math.max(RECORDER_MIN_HEIGHT, Math.min(RECORDER_MAX_HEIGHT, contentHeight)),
  );
  const [outerWidth, outerHeight] = win.getSize();
  const [, currentContentHeight] = win.getContentSize();
  const heightMatches =
    Math.abs(currentContentHeight - targetContentHeight) < 1;
  if (heightMatches && outerWidth === RECORDER_WINDOW_WIDTH) return;

  const targetOuterHeight = outerHeight + targetContentHeight - currentContentHeight;
  win.setSize(RECORDER_WINDOW_WIDTH, targetOuterHeight);
}
