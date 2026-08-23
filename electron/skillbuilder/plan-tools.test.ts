import assert from "node:assert/strict";
import test from "node:test";

import { SkillPlanSchema } from "../../common/skill";
import { validatePlanTooling } from "./plan-tools";

const plan = (tools: string[], allowedTools: string[]) =>
  SkillPlanSchema.parse({
    architecture: "scout",
    name: "test-plan",
    title: "Test plan",
    description: "Test plan tools.",
    steps: [{ kind: "calculation", title: "Test", text: "Test the tools.", tools }],
    allowedTools,
  });

test("validatePlanTooling accepts runtime IDs with matching permissions", () => {
  assert.deepEqual(validatePlanTooling(plan(["view", "glob"], ["Read", "Glob"])), []);
});

test("validatePlanTooling rejects permission names as runtime IDs", () => {
  assert.deepEqual(validatePlanTooling(plan(["Glob"], ["Glob"])), [
    'Unknown Scout runtime tool or skill "Glob".',
  ]);
});

test("validatePlanTooling requires matching filesystem and scoped shell permissions", () => {
  assert.deepEqual(validatePlanTooling(plan(["grep", "bash"], [])), [
    'Runtime tool "grep" requires allowedTools to include "Grep".',
    'Runtime tool "bash" requires a scoped allowedTools pattern such as "Bash(gh *)".',
  ]);
});
