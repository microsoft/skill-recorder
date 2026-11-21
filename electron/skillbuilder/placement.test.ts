import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillPlanSchema, type BuiltSkill } from "../../common/skill";
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

function installFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-install-"));
  process.env.SKILL_RECORDER_SESSIONS_DIR = path.join(root, "sessions");
  process.env.SKILL_RECORDER_SKILLS_DIR = path.join(root, "skills");
  const skill = (name: string, sessionId = "s1"): BuiltSkill => ({
    version: 1, sessionId, architecture: "scout", name, description: "d",
    allowedTools: [], body: "b", values: [], plan: null, createdAt: 0,
  });
  const install = (s: BuiltSkill) => (new SkillBuilder(() => undefined) as any).exportSkill(s) as string;
  return { root, skill, install };
}

test("install keeps the folder name and frontmatter name equal when the folder collides", () => {
  const { root, skill, install } = installFixture();
  mkdirSync(path.join(root, "skills", "foo"), { recursive: true });
  const file = install(skill("foo"));
  assert.equal(path.basename(path.dirname(file)), "foo-2");
  assert.match(readFileSync(file, "utf8"), /^name: foo-2$/m);
});

test("re-install after a rename writes a new folder named after the new name", () => {
  const { root, skill, install } = installFixture();
  const sessionDir = path.join(root, "sessions", "s2");
  mkdirSync(sessionDir, { recursive: true });
  const prior = { ...skill("old-name", "s2"), exportedPath: path.join(root, "skills", "old-name", "SKILL.md") };
  writeFileSync(path.join(sessionDir, "skill.json"), JSON.stringify(prior));
  const file = install(skill("new-name", "s2"));
  assert.equal(path.basename(path.dirname(file)), "new-name");
  assert.match(readFileSync(file, "utf8"), /^name: new-name$/m);
});
