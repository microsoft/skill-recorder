// Skill builder eval harness: runs the real SkillBuilder against each fixed
// scenario and scores the PROPOSED PLAN's shape — the richer contract the builder
// now emits: fixed **values** referenced from step text as `{{id}}` tokens, and an
// ordered list of typed steps (calculation vs action, each with its native tool and an
// optional confirmation pause).
//
// For every scenario it seeds the scenario's FIXED approved analysis (analysis.json)
// + a minimal timeline (bundle.json) into a temp sessions root, runs the real
// SkillBuilder.build (one turn → propose_plan), then scores the plan. No describer,
// no capture — this isolates the builder, the part with the variance we measure.
//
// Run:
//   node --experimental-transform-types --import ./evals/register.mjs evals/skillbuilder/run.ts [flags]
// Flags:
//   --only=slug,slug   run a subset of scenarios
//   --keep             print the temp sessions dir (artifacts kept for inspection)
//   --model=<id>       override the builder model

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillBuilder } from "../../electron/skillbuilder/builder";
import type { SkillPlan } from "../../common/skill";
import { seedScenario } from "../lib/seed";
import { skillScenarios } from "./scenarios";
import { scoreSkill, type SkillScoreResult } from "./score";

interface Flags {
  only: Set<string> | null;
  keep: boolean;
  model?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { only: null, keep: false };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) flags.only = new Set(arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--keep") flags.keep = true;
    else if (arg.startsWith("--model=")) flags.model = arg.slice(8);
  }
  return flags;
}

interface Result {
  id: string;
  title: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  plan?: SkillPlan;
  score?: SkillScoreResult;
}

const bar = "─".repeat(64);

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.model) process.env.SKILL_RECORDER_MODEL = flags.model;

  let root = process.env.SKILL_RECORDER_SESSIONS_DIR;
  if (!root) {
    root = mkdtempSync(path.join(os.tmpdir(), "sr-skill-evals-"));
    process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  }

  const selected = skillScenarios.filter((s) => !flags.only || flags.only.has(s.id));
  if (selected.length === 0) {
    console.error("No scenarios matched", flags.only ? [...flags.only] : "");
    process.exit(2);
  }

  console.error(`\nSkill Recorder — skill builder evals`);
  console.error(`${selected.length} scenario(s) · sessions root: ${root}`);
  console.error(bar);

  const builder = new SkillBuilder((p) => {
    if (p.message) process.stderr.write(`   · [${p.sessionId}] ${p.message}\n`);
  });

  const results: Result[] = [];
  for (const scenario of selected) {
    console.error(`\n▶ ${scenario.id} — ${scenario.title}`);
    const started = Date.now();
    const res: Result = { id: scenario.id, title: scenario.title, ok: false, durationMs: 0 };
    try {
      seedScenario(root, scenario);
      const plan = await builder.build({ sessionId: scenario.id, architecture: scenario.architecture });
      res.plan = plan;
      res.score = scoreSkill(plan, scenario.rubric);
      res.ok = res.score.pass;
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
    }
    res.durationMs = Date.now() - started;
    results.push(res);
    printResult(res);
  }

  await builder.dispose();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(process.cwd(), "evals", "results", `skill-${stamp}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ at: stamp, root, results }, null, 2));

  console.error(`\n${bar}\nSummary`);
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    const pct = r.score ? `${Math.round(r.score.score * 100)}%` : "  — ";
    const status = r.error ? "ERROR" : r.ok ? "PASS " : "FAIL ";
    console.error(`  ${status}  ${pct.padStart(4)}  ${r.id}${r.error ? `  (${r.error})` : ""}`);
  }
  console.error(`\n  ${passed}/${results.length} scenarios passed`);
  if (flags.keep) console.error(`  artifacts: ${root}`);
  console.error(`  results:   ${path.relative(process.cwd(), outFile)}\n`);

  process.exit(passed === results.length ? 0 : 1);
}

function printResult(r: Result): void {
  if (r.error) {
    console.error(`   ✗ error: ${r.error}`);
    return;
  }
  for (const val of r.plan?.values ?? []) {
    console.error(`   value · {{${val.id}}} ${val.name}${val.value ? ` = ${val.value}` : ""}`);
  }
  for (const [i, s] of (r.plan?.steps ?? []).entries()) {
    const tool = s.tools.length ? ` {${s.tools.join(" → ")}}` : "";
    console.error(`   ${i + 1}. [${s.kind}] ${s.text}${tool}`);
  }
  console.error(`   score: ${Math.round((r.score?.score ?? 0) * 100)}% · ${r.ok ? "PASS" : "FAIL"} · ${(r.durationMs / 1000).toFixed(1)}s`);
  for (const c of r.score?.checks ?? []) {
    if (!c.pass) console.error(`     ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(3);
});
