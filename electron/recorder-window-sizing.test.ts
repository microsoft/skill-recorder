import assert from "node:assert/strict";
import test from "node:test";

import {
  fitRecorderHeight,
  type RecorderWindowSizingTarget,
} from "./recorder-window-sizing";

class WindowsFramedWindow implements RecorderWindowSizingTarget {
  destroyed = false;
  size: [number, number] = [400, 500];
  readonly sizeChanges: Array<[number, number]> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getContentSize(): [number, number] {
    return [this.size[0] - 2, this.size[1] - 31];
  }

  getSize(): [number, number] {
    return [...this.size];
  }

  setSize(width: number, height: number): void {
    this.size = [width, height];
    this.sizeChanges.push([width, height]);
  }
}

test("recorder fitting preserves its fixed outer width", () => {
  const win = new WindowsFramedWindow();

  fitRecorderHeight(win, 600);
  assert.deepEqual(win.size, [400, 631]);
  assert.deepEqual(win.getContentSize(), [398, 600]);
  assert.deepEqual(win.sizeChanges, [[400, 631]]);

  for (let i = 0; i < 5; i++) fitRecorderHeight(win, 600);
  assert.deepEqual(win.size, [400, 631]);
  assert.deepEqual(win.sizeChanges, [[400, 631]]);
});

test("recorder fitting repairs width growth even when height already matches", () => {
  const win = new WindowsFramedWindow();
  win.size = [700, 631];

  fitRecorderHeight(win, 600);
  assert.deepEqual(win.size, [400, 631]);

  for (let i = 0; i < 5; i++) fitRecorderHeight(win, 600);
  assert.deepEqual(win.sizeChanges, [[400, 631]]);
});

test("recorder fitting clamps content height and ignores invalid requests", () => {
  const win = new WindowsFramedWindow();

  fitRecorderHeight(win, 10);
  assert.equal(win.getContentSize()[1], 320);

  fitRecorderHeight(win, 10_000);
  assert.equal(win.getContentSize()[1], 720);

  const size = [...win.size];
  fitRecorderHeight(win, Number.NaN);
  assert.deepEqual(win.size, size);

  win.destroyed = true;
  fitRecorderHeight(win, 500);
  assert.deepEqual(win.size, size);
});
