import assert from "node:assert/strict";
import test from "node:test";

test("the eval loader imports both real builders without Vite", async () => {
  const [{ AutomationBuilder }, { SkillBuilder }] = await Promise.all([
    import("../electron/automationbuilder/builder"),
    import("../electron/skillbuilder/builder"),
  ]);

  assert.equal(typeof AutomationBuilder, "function");
  assert.equal(typeof SkillBuilder, "function");
});
