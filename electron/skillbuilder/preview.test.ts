import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { CopilotClient, CopilotSession, type SessionConfig } from "@github/copilot-sdk";

import { AnalysisSchema } from "../../common/analysis";
import type { SkillBuildProgress } from "../../common/ipc";
import { renderSkillMarkdown, SkillPlanSchema, type SkillPlan } from "../../common/skill";
import { loadPersistedSkill, SkillBuilder } from "./builder";

const sessionId = "preview-test";
const plan = SkillPlanSchema.parse({
  architecture: "scout",
  name: "reviewed-skill",
  title: "Reviewed skill",
  description: "A skill to review.",
  allowedTools: ["Bash(gh *)"],
  values: [{ id: "repo", name: "Repository", value: "example/repository" }],
  steps: [{ kind: "calculation", title: "List issues", text: "List issues for {{repo}}.", tools: ["bash"] }],
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(
  t: TestContext,
  options: { beforeTurn?: () => Promise<void>; beforeSession?: () => Promise<void> } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-preview-"));
  const sessions = path.join(root, "sessions");
  const skills = path.join(root, "skills");
  const priorSessions = process.env.SKILL_RECORDER_SESSIONS_DIR;
  const priorSkills = process.env.SKILL_RECORDER_SKILLS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = sessions;
  process.env.SKILL_RECORDER_SKILLS_DIR = skills;
  const progress: SkillBuildProgress[] = [];
  const counts = { turns: 0, sessions: 0, aborts: 0 };
  const client = new CopilotClient();
  t.mock.method(client, "createSession", async (config: SessionConfig) => {
    counts.sessions++;
    await options.beforeSession?.();
    const session = new CopilotSession();
    t.mock.method(session, "abort", async () => { counts.aborts++; });
    t.mock.method(session, "disconnect", async () => undefined);
    t.mock.method(session, "sendAndWait", async (input: string | { prompt: string }) => {
      counts.turns++;
      await options.beforeTurn?.();
      const prompt = typeof input === "string" ? input : input.prompt;
      const toolName = prompt.includes("Call submit_skill") ? "submit_skill" : "propose_plan";
      const tool = config.tools?.find((candidate) => candidate.name === toolName);
      assert.ok(tool);
      assert.ok(tool.handler);
      const payload = toolName === "submit_skill"
        ? { name: "model-name", description: "Model description", allowedTools: ["Bash(gh issue *)"], body: "# Instructions\n\nList issues for {{repo}}.\n\n<script>text only</script>" }
        : plan;
      await tool.handler(payload, { sessionId, toolCallId: "test", toolName, arguments: payload });
      return undefined;
    });
    return session;
  });
  class TestBuilder extends SkillBuilder {
    protected override async ensureClient(): Promise<CopilotClient> {
      return client;
    }
  }
  const builder = new TestBuilder((event) => progress.push(event));
  function seed(id: string) {
    const dir = path.join(sessions, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "analysis.json"), JSON.stringify(AnalysisSchema.parse({
      version: 1, sessionId: id, revision: 1, createdAt: 1,
      intent: "List issues", intentConfidence: "high", intentRationale: "Used gh", steps: [],
    })));
  }
  seed(sessionId);
  t.after(async () => {
    await builder.dispose();
    if (priorSessions === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = priorSessions;
    if (priorSkills === undefined) delete process.env.SKILL_RECORDER_SKILLS_DIR;
    else process.env.SKILL_RECORDER_SKILLS_DIR = priorSkills;
    rmSync(root, { recursive: true, force: true });
  });
  return { builder, root, sessions, skills, counts, progress, seed };
}

test("preview renders the entire final file without installing or marking the session complete", async (t) => {
  const f = fixture(t);
  const preview = await f.builder.prepare(sessionId, plan);
  assert.match(preview.markdown, /^---\nname: reviewed-skill\n/);
  assert.match(preview.markdown, /allowed-tools:\n  - Bash\(gh issue \*\)/);
  assert.match(preview.markdown, /List issues for example\/repository/);
  assert.match(preview.markdown, /<script>text only<\/script>/);
  assert.equal(preview.markdown.includes("{{repo}}"), false);
  assert.equal(existsSync(f.skills), false);
  assert.equal(loadPersistedSkill(sessionId), null);
  assert.match(f.progress.at(-1)?.message ?? "", /Nothing has been installed/);
  assert.deepEqual(await f.builder.prepare(sessionId, plan), preview);
  assert.equal(f.counts.turns, 1);
});

test("reviewed install writes identical bytes once, even after model-session eviction", async (t) => {
  const f = fixture(t);
  const preview = await f.builder.prepare(sessionId, plan);
  await f.builder.evictIdle();
  const result = await f.builder.create(sessionId, plan, { kind: "install" }, preview.id);
  assert.ok(result);
  assert.equal(readFileSync(result.path, "utf8"), preview.markdown);
  assert.equal(renderSkillMarkdown(result.skill), preview.markdown);
  assert.equal(loadPersistedSkill(sessionId)?.exportedPath, result.path);
  assert.equal(f.counts.turns, 1);
  assert.equal(f.counts.sessions, 1);
  await assert.rejects(f.builder.create(sessionId, plan, { kind: "install" }, preview.id), /no longer current/);
});

test("direct placement still generates and installs with no preview step", async (t) => {
  const f = fixture(t);
  const result = await f.builder.create(sessionId, plan);
  assert.ok(result);
  assert.equal(f.counts.turns, 1);
  assert.equal(readFileSync(result.path, "utf8"), renderSkillMarkdown(result.skill));
});

test("direct export picker cancellation does not generate or write anything", async (t) => {
  const f = fixture(t);
  assert.equal(await f.builder.create(sessionId, plan, async () => null), null);
  assert.equal(f.counts.turns, 0);
  assert.equal(f.counts.sessions, 0);
  assert.equal(existsSync(f.skills), false);
  assert.equal(loadPersistedSkill(sessionId), null);
});

test("export-only skills can be reviewed and exported without allowing installation", async (t) => {
  const f = fixture(t);
  const exportPlan: SkillPlan = { ...plan, architecture: "cowork" };
  const preview = await f.builder.prepare(sessionId, exportPlan);
  await assert.rejects(f.builder.create(sessionId, exportPlan, { kind: "install" }, preview.id), /does not support/);
  assert.equal(await f.builder.create(sessionId, exportPlan, async () => null, preview.id), null);
  const result = await f.builder.create(sessionId, exportPlan, { kind: "export", dir: path.join(f.root, "export") }, preview.id);
  assert.ok(result);
  assert.equal(readFileSync(result.path, "utf8"), preview.markdown);
  assert.equal(f.counts.turns, 1);
  assert.equal(existsSync(f.skills), false);
});

test("every edited plan field invalidates reviewed placement without silently regenerating", async (t) => {
  const f = fixture(t);
  const preview = await f.builder.prepare(sessionId, plan);
  const changes: Partial<SkillPlan>[] = [
    { name: "changed" }, { title: "Changed" }, { description: "Changed" },
    { summary: "Changed" }, { generalization: "Changed" }, { architecture: "cowork" },
    { allowedTools: ["Read"] }, { values: [{ id: "repo", name: "Repository", value: "changed/repo" }] },
    { steps: [] },
  ];
  for (const change of changes) {
    await assert.rejects(
      f.builder.create(sessionId, { ...plan, ...change }, { kind: "export", dir: f.root }, preview.id),
      /no longer current/,
    );
  }
  assert.equal(f.counts.turns, 1);
  assert.equal(existsSync(f.skills), false);
});

test("changed plans produce a new candidate and old discard requests cannot clear it", async (t) => {
  const f = fixture(t);
  const old = await f.builder.prepare(sessionId, plan);
  const changed = { ...plan, description: "Updated description" };
  const next = await f.builder.prepare(sessionId, changed);
  assert.notEqual(next.id, old.id);
  f.builder.discardPreview(sessionId, old.id);
  assert.deepEqual(await f.builder.prepare(sessionId, changed), next);
  assert.equal(f.counts.turns, 2);
  await assert.rejects(f.builder.create(sessionId, changed, { kind: "install" }, old.id), /no longer current/);
  assert.ok(await f.builder.create(sessionId, changed, { kind: "install" }, next.id));
});

test("candidate IDs cannot cross sessions, and explicit discard prevents later placement", async (t) => {
  const f = fixture(t);
  const preview = await f.builder.prepare(sessionId, plan);
  f.seed("another-session");
  await assert.rejects(f.builder.create("another-session", plan, { kind: "install" }, preview.id), /no longer current/);
  f.builder.discardPreview(sessionId, preview.id);
  await assert.rejects(f.builder.create(sessionId, plan, { kind: "install" }, preview.id), /no longer current/);
  assert.equal(f.counts.turns, 1);
});

test("write failure keeps the reviewed candidate available for retry", async (t) => {
  const f = fixture(t);
  const preview = await f.builder.prepare(sessionId, plan);
  const blocked = path.join(f.root, "not-a-directory");
  writeFileSync(blocked, "file");
  await assert.rejects(f.builder.create(sessionId, plan, { kind: "export", dir: blocked }, preview.id));
  assert.deepEqual(await f.builder.prepare(sessionId, plan), preview);
  const result = await f.builder.create(sessionId, plan, { kind: "install" }, preview.id);
  assert.ok(result);
  assert.equal(readFileSync(result.path, "utf8"), preview.markdown);
  assert.equal(f.counts.turns, 1);
});

test("cancel during generation rejects late model output and permits a clean retry", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, { beforeTurn: async () => { entered.resolve(); await release.promise; } });
  const work = f.builder.prepare(sessionId, plan);
  const rejected = assert.rejects(work, /canceled/);
  await entered.promise;
  await assert.rejects(f.builder.prepare(sessionId, plan), /Wait for the current step/);
  await assert.rejects(f.builder.create(sessionId, plan), /Wait for the current step/);
  await f.builder.cancel(sessionId);
  release.resolve();
  await rejected;
  assert.equal(existsSync(f.skills), false);
  assert.equal(loadPersistedSkill(sessionId), null);
  await f.builder.prepare(sessionId, plan);
  assert.equal(f.counts.turns, 2);
});

test("cancel while connecting prevents any subsequent model turn", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, { beforeSession: async () => { entered.resolve(); await release.promise; } });
  const work = f.builder.prepare(sessionId, plan);
  const rejected = assert.rejects(work, /canceled/);
  await entered.promise;
  await f.builder.cancel(sessionId);
  release.resolve();
  await rejected;
  assert.equal(f.counts.turns, 0);
  assert.equal(existsSync(f.skills), false);
});

test("canceling direct creation never places late model output", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = fixture(t, { beforeTurn: async () => { entered.resolve(); await release.promise; } });
  const work = f.builder.create(sessionId, plan);
  const rejected = assert.rejects(work, /canceled/);
  await entered.promise;
  await f.builder.cancel(sessionId);
  release.resolve();
  await rejected;
  assert.equal(existsSync(f.skills), false);
  assert.equal(loadPersistedSkill(sessionId), null);
});

test("generation errors remain explicit and release the operation for retry", async (t) => {
  let fail = true;
  const f = fixture(t, { beforeTurn: async () => {
    if (fail) throw new Error("Model transport unavailable");
  } });
  await assert.rejects(f.builder.prepare(sessionId, plan), /Skill build failed: Model transport unavailable/);
  assert.equal(existsSync(f.skills), false);
  assert.equal(loadPersistedSkill(sessionId), null);
  assert.equal(f.counts.aborts, 1);
  fail = false;
  assert.ok(await f.builder.prepare(sessionId, plan));
  assert.equal(f.counts.turns, 2);
});

test("cancel or discard while the folder picker is open cannot install a reviewed candidate", async (t) => {
  const f = fixture(t);
  const preview = await f.builder.prepare(sessionId, plan);
  const entered = deferred();
  const release = deferred();
  const work = f.builder.create(sessionId, plan, async () => {
    entered.resolve();
    await release.promise;
    return { kind: "install" };
  }, preview.id);
  const rejected = assert.rejects(work, /canceled/);
  await entered.promise;
  await f.builder.cancel(sessionId);
  release.resolve();
  await rejected;
  assert.equal(existsSync(f.skills), false);
  await assert.rejects(f.builder.create(sessionId, plan, async () => {
    f.builder.discardPreview(sessionId);
    return { kind: "install" };
  }, preview.id), /no longer current/);
});

test("fresh planning, forgetting a recording, and shutdown discard candidates", async (t) => {
  const f = fixture(t);
  let preview = await f.builder.prepare(sessionId, plan);
  await f.builder.build({ sessionId, architecture: plan.architecture });
  await assert.rejects(f.builder.create(sessionId, plan, { kind: "install" }, preview.id), /no longer current/);
  preview = await f.builder.prepare(sessionId, plan);
  await f.builder.forget(sessionId);
  await assert.rejects(f.builder.create(sessionId, plan, { kind: "install" }, preview.id), /no longer current/);
  preview = await f.builder.prepare(sessionId, plan);
  await f.builder.dispose();
  await assert.rejects(f.builder.create(sessionId, plan, { kind: "install" }, preview.id), /no longer current/);
});

test("preview cache is bounded and expired candidates fail rather than regenerate", async (t) => {
  const f = fixture(t);
  const first = await f.builder.prepare(sessionId, plan);
  for (let n = 0; n < 4; n++) {
    const id = `another-${n}`;
    f.seed(id);
    await f.builder.prepare(id, plan);
  }
  await assert.rejects(f.builder.create(sessionId, plan, { kind: "install" }, first.id), /no longer current/);
  assert.equal(f.counts.turns, 5);
});

test("reviewed placement preserves collision handling and reinstall behavior", async (t) => {
  const f = fixture(t);
  const unrelated = path.join(f.skills, plan.name);
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(path.join(unrelated, "SKILL.md"), "Unrelated skill");
  const preview = await f.builder.prepare(sessionId, plan);
  const first = await f.builder.create(sessionId, plan, { kind: "install" }, preview.id);
  assert.ok(first);
  assert.equal(path.basename(path.dirname(first.path)), `${plan.name}-2`);
  const next = await f.builder.prepare(sessionId, plan);
  const second = await f.builder.create(sessionId, plan, { kind: "install" }, next.id);
  assert.ok(second);
  assert.equal(second.path, first.path);
  assert.equal(readFileSync(path.join(unrelated, "SKILL.md"), "utf8"), "Unrelated skill");
});
