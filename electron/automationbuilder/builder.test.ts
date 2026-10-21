import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AutomationPlan, BuiltAutomation } from "../../common/automation";
import { sessionDir } from "../recorder/session-store";
import { AutomationBuilder } from "./builder";

function samplePlan(overrides: Partial<AutomationPlan> = {}): AutomationPlan {
  return {
    architecture: "scout",
    name: "daily-digest",
    title: "Daily digest",
    description: "Sends a daily digest.",
    summary: "",
    generalization: "",
    trigger: {
      type: "schedule",
      schedule: { kind: "single", naturalLanguage: "", days: [], time: { hour: 9, minute: 0 } },
      condition: "",
    },
    values: [],
    steps: [{ label: "Send digest", prompt: "Send the daily digest email." }],
    model: "",
    skillNames: [],
    ...overrides,
  };
}

test("exportAutomation refuses to reuse a re-exported path outside the automations root", async () => {
  const automationsRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-automations-"));
  const sessionsRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-sessions-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-outside-"));

  const previousAutomationsDir = process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
  const previousSessionsDir = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_AUTOMATIONS_DIR = automationsRoot;
  process.env.SKILL_RECORDER_SESSIONS_DIR = sessionsRoot;

  try {
    const sessionId = "attack-session";

    // Seed a persisted automation whose exportedPath was relocated outside the
    // automations root (e.g. a tampered/relocated built-automation.json).
    const maliciousExportedPath = path.join(outsideRoot, "automation.json");
    const priorAutomation: BuiltAutomation = {
      version: 1,
      sessionId,
      kind: "automation",
      architecture: "scout",
      name: "daily-digest",
      description: "",
      triggerType: "schedule",
      schedule: { kind: "single", naturalLanguage: "", days: [], time: { hour: 9, minute: 0 } },
      condition: "",
      model: "",
      steps: [{ label: "Send digest", prompt: "Send the daily digest email." }],
      values: [],
      plan: null,
      createdAt: Date.now(),
      exportedPath: maliciousExportedPath,
      exportedAt: Date.now(),
    };
    await mkdir(sessionDir(sessionId), { recursive: true });
    await writeFile(path.join(sessionDir(sessionId), "built-automation.json"), JSON.stringify(priorAutomation));

    const builder = new AutomationBuilder(() => undefined);
    const { path: exportedPath } = await builder.create(sessionId, samplePlan());

    // The export must land inside the automations root, never inside the
    // attacker-controlled outside directory the prior exportedPath pointed to.
    const relative = path.relative(automationsRoot, exportedPath);
    assert.ok(
      relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
      `expected export path inside ${automationsRoot}, got ${exportedPath}`,
    );
    assert.notEqual(path.dirname(exportedPath), outsideRoot);

    // Nothing should have been written into the attacker-controlled directory.
    await assert.rejects(readFile(maliciousExportedPath));
  } finally {
    if (previousAutomationsDir === undefined) delete process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
    else process.env.SKILL_RECORDER_AUTOMATIONS_DIR = previousAutomationsDir;
    if (previousSessionsDir === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousSessionsDir;
  }
});

test("exportAutomation reuses a prior export path when it is inside the automations root", async () => {
  const automationsRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-automations-"));
  const sessionsRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-sessions-"));

  const previousAutomationsDir = process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
  const previousSessionsDir = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_AUTOMATIONS_DIR = automationsRoot;
  process.env.SKILL_RECORDER_SESSIONS_DIR = sessionsRoot;

  try {
    const sessionId = "reuse-session";
    const priorDir = path.join(automationsRoot, "daily-digest");
    const priorExportedPath = path.join(priorDir, "automation.json");

    const priorAutomation: BuiltAutomation = {
      version: 1,
      sessionId,
      kind: "automation",
      architecture: "scout",
      name: "daily-digest",
      description: "",
      triggerType: "schedule",
      schedule: { kind: "single", naturalLanguage: "", days: [], time: { hour: 9, minute: 0 } },
      condition: "",
      model: "",
      steps: [{ label: "Send digest", prompt: "Send the daily digest email." }],
      values: [],
      plan: null,
      createdAt: Date.now(),
      exportedPath: priorExportedPath,
      exportedAt: Date.now(),
    };
    await mkdir(sessionDir(sessionId), { recursive: true });
    await writeFile(path.join(sessionDir(sessionId), "built-automation.json"), JSON.stringify(priorAutomation));

    const builder = new AutomationBuilder(() => undefined);
    const { path: exportedPath } = await builder.create(sessionId, samplePlan());

    assert.equal(exportedPath, priorExportedPath);
  } finally {
    if (previousAutomationsDir === undefined) delete process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
    else process.env.SKILL_RECORDER_AUTOMATIONS_DIR = previousAutomationsDir;
    if (previousSessionsDir === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousSessionsDir;
  }
});
