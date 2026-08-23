import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDisplayLabels,
  resolveScreenPreference,
  type ScreenSource,
} from "./screen";

const sources: ScreenSource[] = [
  { id: "screen:1:0", label: "Screen 1", displayId: "101" },
  { id: "screen:2:0", label: "Screen 2", displayId: "202" },
];

test("screen preference resolves exact and changed source ids", () => {
  const exact = resolveScreenPreference(
    { id: "screen:1:0", label: "Screen 1", displayId: "101" },
    sources,
  );
  assert.equal(exact.source?.id, "screen:1:0");
  assert.equal(exact.unavailable, false);
  assert.equal(exact.changed, false);

  const changedId = resolveScreenPreference(
    { id: "screen:old:0", label: "Screen 2", displayId: "202" },
    sources,
  );
  assert.equal(changedId.source?.id, "screen:2:0");
  assert.equal(changedId.preference?.id, "screen:2:0");
  assert.equal(changedId.unavailable, false);
  assert.equal(changedId.changed, true);
});

test("stable display identity wins when Electron reassigns source ids", () => {
  const reassigned: ScreenSource[] = [
    { id: "screen:1:0", label: "Screen 2", displayId: "202" },
    { id: "screen:2:0", label: "Screen 1", displayId: "101" },
  ];
  const resolved = resolveScreenPreference(
    { id: "screen:1:0", label: "Screen 1", displayId: "101" },
    reassigned,
  );

  assert.equal(resolved.source?.id, "screen:2:0");
  assert.equal(resolved.source?.displayId, "101");
  assert.equal(resolved.changed, true);
});

test("a reassigned source id does not impersonate a disconnected display", () => {
  const preference = {
    id: "screen:1:0",
    label: "Travel display",
    displayId: "303",
  };
  const resolved = resolveScreenPreference(preference, [
    { id: "screen:1:0", label: "Travel display", displayId: "101" },
    sources[1],
  ]);

  assert.equal(resolved.unavailable, true);
  assert.deepEqual(resolved.preference, preference);
});

test("missing screen visibly falls back without forgetting the preference", () => {
  const preference = {
    id: "screen:travel:0",
    label: "Travel display",
    displayId: "303",
  };
  const resolved = resolveScreenPreference(preference, sources);

  assert.equal(resolved.source?.id, "screen:1:0");
  assert.deepEqual(resolved.preference, preference);
  assert.equal(resolved.unavailable, true);
  assert.equal(resolved.changed, false);
});

test("first available screen becomes the initial preference", () => {
  const resolved = resolveScreenPreference(null, sources);

  assert.deepEqual(resolved.source, sources[0]);
  assert.deepEqual(resolved.preference, sources[0]);
  assert.equal(resolved.unavailable, false);
  assert.equal(resolved.changed, true);
});

test("an empty catalog has no selected screen", () => {
  const resolved = resolveScreenPreference(null, []);

  assert.equal(resolved.source, null);
  assert.equal(resolved.preference, null);
  assert.equal(resolved.unavailable, true);
  assert.equal(resolved.changed, false);
});

test("screen sources use display model labels and disambiguate duplicates", () => {
  const labeled = applyDisplayLabels(sources, new Map([
    ["101", "HP E27 G5"],
    ["202", "HP E27 G5"],
  ]));

  assert.deepEqual(
    labeled.map((source) => source.label),
    ["HP E27 G5 (1)", "HP E27 G5 (2)"],
  );
});

test("screen sources retain capture labels when display metadata is unavailable", () => {
  const labeled = applyDisplayLabels(sources, new Map());

  assert.deepEqual(
    labeled.map((source) => source.label),
    ["Screen 1", "Screen 2"],
  );
});
