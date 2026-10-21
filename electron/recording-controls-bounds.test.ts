import assert from "node:assert/strict";
import test from "node:test";

import {
  RECORDING_CONTROLS_SIZE,
  clampRecordingControlsBounds,
  initialRecordingControlsBounds,
  resizeRecordingControlsBounds,
} from "./recording-controls-bounds";

test("recording controls start bottom-center inside the work area", () => {
  const workArea = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(initialRecordingControlsBounds(workArea), {
    x: -1240,
    y: 946,
    width: RECORDING_CONTROLS_SIZE.width,
    height: RECORDING_CONTROLS_SIZE.collapsedHeight,
  });
});

test("recording controls clamp to negative-coordinate and small displays", () => {
  assert.deepEqual(
    clampRecordingControlsBounds(
      { x: -2500, y: 1300, width: 560, height: 250 },
      { x: -1920, y: 0, width: 1280, height: 720 },
    ),
    { x: -1920, y: 470, width: 560, height: 250 },
  );

  assert.deepEqual(
    clampRecordingControlsBounds(
      { x: 10, y: 10, width: 560, height: 250 },
      { x: 0, y: 0, width: 320, height: 180 },
    ),
    { x: 0, y: 0, width: 320, height: 180 },
  );
});

test("overlay panel expansion preserves the bar's bottom edge", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const collapsed = { x: 440, y: 806, width: 560, height: 76 };
  const expanded = resizeRecordingControlsBounds(collapsed, true, workArea);
  assert.deepEqual(expanded, { x: 440, y: 632, width: 560, height: 250 });
  assert.equal(expanded.y + expanded.height, collapsed.y + collapsed.height);
  assert.deepEqual(
    resizeRecordingControlsBounds(expanded, false, workArea),
    collapsed,
  );
});
