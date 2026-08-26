import assert from "node:assert/strict";
import test from "node:test";

import { SkillPlanSchema } from "../../common/skill";
import { SkillBuilder } from "./builder";

test("skill creation rejects a placement unsupported by the plan architecture", async () => {
  const builder = new SkillBuilder(() => undefined);
  const plan = SkillPlanSchema.parse({
    architecture: "cowork",
    name: "reviewed-skill",
    title: "Reviewed skill",
    description: "A reviewed skill.",
  });

  await assert.rejects(
    builder.create("placement-validation", plan, { kind: "install" }),
    /Architecture "cowork" target "skill" does not support "install" placement/,
  );
});
