import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AutomationPlanSchema } from "../../common/automation";
import { AutomationBuilder, loadPersistedAutomation } from "./builder";

test("automation re-export refuses persisted targets outside the automations root", async () => {
  await withRoots(async ({ automationsRoot, sessionsRoot, outsideRoot }) => {
    const builder = new AutomationBuilder(() => undefined);
    const sessionId = "automation-reexport-safety";
    mkdirSync(path.join(sessionsRoot, sessionId), { recursive: true });
    const plan = AutomationPlanSchema.parse({
      architecture: "cowork",
      name: "daily-digest",
      title: "Daily digest",
      description: "Build a daily digest automation.",
      trigger: {
        type: "schedule",
        schedule: {
          kind: "single",
          naturalLanguage: "Every weekday at 09:00",
          days: [1, 2, 3, 4, 5],
          time: { hour: 9, minute: 0 },
        },
      },
      steps: [{ label: "Draft", prompt: "Draft the digest." }],
    });

    const first = await builder.create(sessionId, plan);
    assert.match(first.path, new RegExp(`^${escapeRegExp(automationsRoot)}`));

    const persistedPath = path.join(sessionsRoot, sessionId, "built-automation.json");
    const persisted = loadPersistedAutomation(sessionId);
    assert.ok(persisted?.exportedPath, "expected first create() to persist an exported path");

    const escaped = path.join(outsideRoot, "escaped", "automation.json");
    await writeFile(
      persistedPath,
      `${JSON.stringify({ ...persisted, exportedPath: escaped }, null, 2)}\n`,
      "utf8",
    );

    const second = await builder.create(sessionId, plan);
    assert.match(second.path, new RegExp(`^${escapeRegExp(automationsRoot)}`));
    assert.doesNotMatch(second.path, new RegExp(`^${escapeRegExp(outsideRoot)}`));

    const rendered = readFileSync(second.path, "utf8");
    assert.match(rendered, /daily-digest/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withRoots(
  run: (roots: { automationsRoot: string; sessionsRoot: string; outsideRoot: string }) => Promise<void>,
): Promise<void> {
  const automationsRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-automations-"));
  const sessionsRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-sessions-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "skill-recorder-outside-"));
  const previousAutomations = process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
  const previousSessions = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_AUTOMATIONS_DIR = automationsRoot;
  process.env.SKILL_RECORDER_SESSIONS_DIR = sessionsRoot;
  try {
    await run({ automationsRoot, sessionsRoot, outsideRoot });
  } finally {
    if (previousAutomations === undefined) delete process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
    else process.env.SKILL_RECORDER_AUTOMATIONS_DIR = previousAutomations;
    if (previousSessions === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousSessions;
    await Promise.all([
      rm(automationsRoot, { recursive: true, force: true }),
      rm(sessionsRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
}