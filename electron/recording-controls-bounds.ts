export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const RECORDING_CONTROLS_SIZE = {
  width: 560,
  collapsedHeight: 76,
  expandedHeight: 250,
  margin: 18,
} as const;

/** Place a new control bar at the bottom center of a display's usable work area. */
export function initialRecordingControlsBounds(
  workArea: WindowBounds,
  expanded = false,
): WindowBounds {
  const height = expanded
    ? RECORDING_CONTROLS_SIZE.expandedHeight
    : RECORDING_CONTROLS_SIZE.collapsedHeight;
  return {
    x: Math.round(workArea.x + (workArea.width - RECORDING_CONTROLS_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height - RECORDING_CONTROLS_SIZE.margin - height),
    width: RECORDING_CONTROLS_SIZE.width,
    height,
  };
}

/** Keep the full overlay visible after dragging, scaling, or display removal. */
export function clampRecordingControlsBounds(
  bounds: WindowBounds,
  workArea: WindowBounds,
): WindowBounds {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.round(clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

/**
 * Resize the transparent overlay above its fixed bar. Its bottom edge remains
 * stationary, so opening a menu or confirmation never makes the control bar jump.
 */
export function resizeRecordingControlsBounds(
  bounds: WindowBounds,
  expanded: boolean,
  workArea: WindowBounds,
): WindowBounds {
  const height = expanded
    ? RECORDING_CONTROLS_SIZE.expandedHeight
    : RECORDING_CONTROLS_SIZE.collapsedHeight;
  const bottom = bounds.y + bounds.height;
  return clampRecordingControlsBounds(
    {
      x: bounds.x,
      y: bottom - height,
      width: RECORDING_CONTROLS_SIZE.width,
      height,
    },
    workArea,
  );
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}
