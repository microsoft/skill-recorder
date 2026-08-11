// Eval harness: runs the multi-turn Copilot describer against each fixed
// scenario and scores the resulting analysis against its rubric.
//
// For every scenario it: materializes a synthetic session (session.json +
// events.jsonl) into a temp sessions root, runs the real post-stop pipeline
// (processSession → bundle.json + description.md), invokes the real
// Describer.analyze (the same agent the app uses), then scores the analysis.
//
// Run:
//   node --experimental-transform-types --import ./evals/register.mjs evals/run.ts [flags]
// Flags:
//   --only=slug,slug   run a subset of scenarios
//   --judge            also run the optional semantic LLM judge
//   --keep             print the temp sessions dir (artifacts kept for inspection)
//   --model=<id>       override the describer model (else auto vision model)

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Analysis } from "../common/analysis";
import { TERMINAL_ARTIFACTS } from "../common/terminal";
import { processSession } from "../electron/pipeline";
import { Describer } from "../electron/describer/describer";
import { buildRedactor, scanSession } from "../electron/sensitive/scanner";
import { judgeAnalysis, type JudgeResult } from "./judge";
import { makeSessionMeta, materializeEvents, type Scenario } from "./scenario";
import { scenarios } from "./scenarios/index";
import { scoreAnalysis, type ScoreResult } from "./scoring";

interface Flags {
  only: Set<string> | null;
  judge: boolean;
  keep: boolean;
  model?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { only: null, judge: false, keep: false };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) flags.only = new Set(arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--judge") flags.judge = true;
    else if (arg === "--keep") flags.keep = true;
    else if (arg.startsWith("--model=")) flags.model = arg.slice(8);
  }
  return flags;
}

interface ScenarioResult {
  id: string;
  title: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  stepCount?: number;
  intent?: string;
  score?: ScoreResult;
  judge?: JudgeResult;
}

function materialize(root: string, scenario: Scenario): string {
  const startedAt = Date.now();
  const raw = scenario.build();
  const durationMs = Math.max(0, ...raw.map((e) => e.atMs)) + 1000;
  const events = materializeEvents(raw, startedAt);
  const meta = makeSessionMeta(scenario.id, startedAt, durationMs, scenario.platform ?? "darwin");

  const dir = path.join(root, scenario.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "session.json"), JSON.stringify(meta, null, 2));
  writeFileSync(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  if (scenario.terminal) {
    const terminalDir = path.join(dir, TERMINAL_ARTIFACTS.directory);
    mkdirSync(terminalDir, { recursive: true });
    const cast = [
      JSON.stringify({
        version: 2,
        width: 100,
        height: 30,
        timestamp: Math.floor(startedAt / 1000),
        env: { TERM: "xterm-256color", SHELL: "eval" },
      }),
      ...scenario.terminal.output.map((entry) =>
        JSON.stringify([entry.atMs / 1000, "o", entry.text]),
      ),
    ];
    writeFileSync(
      path.join(terminalDir, TERMINAL_ARTIFACTS.transcript),
      `${cast.join("\n")}\n`,
    );
    writeFileSync(
      path.join(terminalDir, TERMINAL_ARTIFACTS.commands),
      `${scenario.terminal.commands.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }
  return dir;
}

const bar = "─".repeat(64);

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.model) process.env.SKILL_RECORDER_MODEL = flags.model;

  // Sessions root: honor an external override, else an isolated temp dir.
  let root = process.env.SKILL_RECORDER_SESSIONS_DIR;
  if (!root) {
    root = mkdtempSync(path.join(os.tmpdir(), "sr-evals-"));
    process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  }

  const selected = scenarios.filter((s) => !flags.only || flags.only.has(s.id));
  if (selected.length === 0) {
    console.error("No scenarios matched", flags.only ? [...flags.only] : "");
    process.exit(2);
  }

  console.error(`\nSkill Recorder — describer evals`);
  console.error(`${selected.length} scenario(s) · sessions root: ${root}`);
  if (flags.judge) console.error("semantic judge: ON");
  console.error(bar);

  const describer = new Describer((p) => {
    if (p.message) process.stderr.write(`   · [${p.sessionId}] ${p.message}\n`);
  });

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    console.error(`\n▶ ${scenario.id} — ${scenario.title}`);
    const started = Date.now();
    const res: ScenarioResult = { id: scenario.id, title: scenario.title, ok: false, durationMs: 0 };
    try {
      const dir = materialize(root, scenario);
      await processSession(dir);
      const { values } = await scanSession(scenario.id);
      const analysis: Analysis = await describer.analyze(scenario.id, {
        redactText: buildRedactor(values),
        frameRedactor: null,
      });
      res.stepCount = analysis.steps.length;
      res.intent = analysis.intent;
      res.score = scoreAnalysis(analysis, scenario.rubric);
      res.ok = res.score.pass;
      const leaked = scenario.sensitiveValues?.find((value) =>
        JSON.stringify(analysis).includes(value),
      );
      if (leaked) {
        res.ok = false;
        res.error = "Sensitive terminal output reached the final analysis.";
      }
      if (flags.judge) {
        try {
          res.judge = await judgeAnalysis(scenario, analysis, flags.model);
        } catch (err) {
          console.error(`   judge failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
    }
    res.durationMs = Date.now() - started;
    results.push(res);
    printScenario(res);
  }

  await describer.dispose();

  // Persist + summarize.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(process.cwd(), "evals", "results", `${stamp}.json`);
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

function printScenario(r: ScenarioResult): void {
  if (r.error) {
    console.error(`   ✗ error: ${r.error}`);
    return;
  }
  console.error(`   intent: ${r.intent}`);
  console.error(`   steps: ${r.stepCount} · score: ${Math.round((r.score?.score ?? 0) * 100)}% · ${r.ok ? "PASS" : "FAIL"} · ${(r.durationMs / 1000).toFixed(1)}s`);
  for (const c of r.score?.checks ?? []) {
    if (!c.pass) console.error(`     ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (r.judge) console.error(`   judge: ${r.judge.score}/5 — ${r.judge.verdict}`);
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(3);
});
