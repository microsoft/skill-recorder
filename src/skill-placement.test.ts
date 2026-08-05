import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TARGET, TARGETS } from "../common/skill";
import { skillPlacementModel, skillTargetFor } from "./skill-placement";

test("placement model preserves Scout and Cowork action ordering", () => {
  const defaultSkill = skillPlacementModel(skillTargetFor(DEFAULT_TARGET.architecture));
  assert.equal(defaultSkill.defaultPlacement, "install");
  assert.deepEqual(
    defaultSkill.actions.map(({ placement, primary, label }) => [placement, primary, label]),
    [
      ["export", false, "Export…"],
      ["install", true, "Add to Scout"],
    ],
  );
  assert.equal(defaultSkill.installDoneTitle, "Added to Scout");
  assert.equal(defaultSkill.installDoneMessage, "is now in Scout — it loads automatically.");

  const exportOnlyTarget = TARGETS.find(
    (target) =>
      target.kind === "skill" &&
      target.enabled &&
      target.placements.length === 1 &&
      target.placements[0] === "export" &&
      target.architecture !== DEFAULT_TARGET.architecture,
  );
  assert.ok(exportOnlyTarget);

  const exportOnly = skillPlacementModel(skillTargetFor(exportOnlyTarget.architecture));
  assert.equal(exportOnly.defaultPlacement, "export");
  assert.deepEqual(
    exportOnly.actions.map(({ placement, primary, label }) => [placement, primary, label]),
    [["export", true, "Export skill"]],
  );
});
