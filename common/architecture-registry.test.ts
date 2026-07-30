import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECTURES,
  SkillArchitecture,
  TARGETS,
  defineArchitectures,
  enabledArchitectureLabels,
} from "./architecture-registry";

test("the manifest derives architecture validation and target availability", () => {
  assert.deepEqual(SkillArchitecture.options, [
    "scout",
    "cowork",
    "copilot-studio",
  ]);
  assert.equal(SkillArchitecture.safeParse("generic").success, false);

  assert.deepEqual(
    ARCHITECTURES.map(({ id, enabled }) => [id, enabled]),
    [
      ["scout", true],
      ["cowork", true],
      ["copilot-studio", false],
    ],
  );
  assert.deepEqual(
    TARGETS.map(({ architecture, kind, enabled }) => [
      architecture,
      kind,
      enabled,
    ]),
    [
      ["scout", "skill", true],
      ["scout", "automation", true],
      ["cowork", "skill", true],
      ["copilot-studio", "skill", false],
    ],
  );

  assert.deepEqual(enabledArchitectureLabels("skill"), ["Scout", "Cowork"]);
  assert.deepEqual(enabledArchitectureLabels("automation"), ["Scout"]);
});

test("architecture definitions reject invalid registry shapes", () => {
  const skill = {
    kind: "skill" as const,
    label: "Skill",
    enabled: true,
    note: "Enabled.",
  };

  assert.throws(
    () => defineArchitectures([]),
    /Architecture manifest must contain at least one architecture/,
  );
  assert.throws(
    () =>
      defineArchitectures([
        { id: "duplicate", label: "First", note: "First.", targets: [skill] },
        { id: "duplicate", label: "Second", note: "Second.", targets: [skill] },
      ]),
    /Duplicate architecture id "duplicate"/,
  );
  assert.throws(
    () =>
      defineArchitectures([
        { id: "empty", label: "Empty", note: "Empty.", targets: [] },
      ]),
    /Architecture "empty" must declare at least one target/,
  );
  assert.throws(
    () =>
      defineArchitectures([
        {
          id: "duplicate-kind",
          label: "Duplicate kind",
          note: "Invalid.",
          targets: [skill, { ...skill, label: "Another skill" }],
        },
      ]),
    /Architecture "duplicate-kind" declares "skill" more than once/,
  );
});
