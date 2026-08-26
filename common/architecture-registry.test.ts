import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECTURES,
  DEFAULT_TARGET,
  SkillArchitecture,
  TARGETS,
  buildTargetFor,
  defineArchitectures,
  enabledArchitectureLabels,
  requireTargetPlacement,
} from "./architecture-registry";
import type {
  ArchitectureDefinition,
  ArchitectureTargetDefinition,
} from "./architecture-registry";

test("the manifest derives architecture validation and target availability", () => {
  assert.deepEqual(SkillArchitecture.options, [
    "scout",
    "cowork",
    "agent-skill",
    "copilot-studio",
  ]);
  assert.equal(SkillArchitecture.safeParse("generic").success, false);

  assert.deepEqual(
    ARCHITECTURES.map(({ id, enabled }) => [id, enabled]),
    [
      ["scout", true],
      ["cowork", true],
      ["agent-skill", true],
      ["copilot-studio", false],
    ],
  );
  assert.deepEqual(
    TARGETS.map(
      ({ architecture, kind, enabled, placements, installTargetLabel }) => [
        architecture,
        kind,
        enabled,
        placements,
        installTargetLabel,
      ],
    ),
    [
      ["scout", "skill", true, ["install", "export"], "Scout"],
      ["scout", "automation", true, ["install"], "Scout"],
      ["cowork", "skill", true, ["export"], "Microsoft 365 Copilot"],
      ["agent-skill", "skill", true, ["export"], "your agent"],
      ["copilot-studio", "skill", false, ["export"], "Copilot Studio"],
    ],
  );
  assert.equal(DEFAULT_TARGET.architecture, "scout");
  assert.equal(DEFAULT_TARGET.kind, "skill");
  assert.equal(
    buildTargetFor(DEFAULT_TARGET.architecture, "automation").installTargetLabel,
    "Scout",
  );

  assert.deepEqual(enabledArchitectureLabels("skill"), [
    "Scout",
    "Cowork",
    "Agent skill",
  ]);
  assert.deepEqual(enabledArchitectureLabels("automation"), ["Scout"]);
});

test("target placements are enforced from the manifest", () => {
  assert.equal(requireTargetPlacement("scout", "skill", "install").architecture, "scout");
  assert.equal(requireTargetPlacement("cowork", "skill", "export").architecture, "cowork");
  assert.throws(
    () => requireTargetPlacement("cowork", "skill", "install"),
    /Architecture "cowork" target "skill" does not support "install" placement/,
  );
  assert.throws(
    () => requireTargetPlacement("copilot-studio", "skill", "export"),
    /Architecture "copilot-studio" target "skill" is not enabled/,
  );
});

test("architecture definitions reject invalid registry shapes", () => {
  const skill = {
    kind: "skill" as const,
    label: "Skill",
    enabled: true,
    note: "Enabled.",
    placements: ["install"] as const,
  };
  const architecture = (
    id: string,
    targets: readonly ArchitectureTargetDefinition[] = [skill],
  ): ArchitectureDefinition => ({
    id,
    label: id,
    installTargetLabel: id,
    note: `${id}.`,
    targets,
  });

  assert.throws(
    () => defineArchitectures([]),
    /Architecture manifest must contain at least one architecture/,
  );
  assert.throws(
    () => defineArchitectures([architecture("duplicate"), architecture("duplicate")]),
    /Duplicate architecture id "duplicate"/,
  );
  assert.throws(
    () => defineArchitectures([architecture("empty", [])]),
    /Architecture "empty" must declare at least one target/,
  );
  assert.throws(
    () =>
      defineArchitectures([
        architecture("duplicate-kind", [skill, { ...skill, label: "Another skill" }]),
      ]),
    /Architecture "duplicate-kind" declares "skill" more than once/,
  );
  assert.throws(
    () =>
      defineArchitectures([
        {
          ...architecture("empty-placement-list"),
          targets: [{ ...skill, placements: [] }],
        },
      ]),
    /Architecture "empty-placement-list" target "skill" must declare at least one placement/,
  );
  assert.throws(
    () =>
      defineArchitectures([
        {
          ...architecture("duplicate-placement"),
          targets: [{ ...skill, placements: ["install", "install"] }],
        },
      ]),
    /Architecture "duplicate-placement" target "skill" declares placement "install" more than once/,
  );
  assert.throws(
    () =>
      defineArchitectures([
        {
          ...architecture("blank-install-target"),
          installTargetLabel: "   ",
        },
      ]),
    /Architecture "blank-install-target" must declare an install target label\./,
  );
});
