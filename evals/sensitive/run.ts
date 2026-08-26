// Sensitive-detail eval harness: runs the real on-device detection + redaction
// pipeline (secretlint + structured-PII regex) over a fixed corpus and scores
// recall (every known secret/PII value is masked before it could leave the
// machine) and precision (ordinary prose is left intact). No model weights, no
// network, no LLM — fully deterministic.
//
// Run:
//   node --experimental-transform-types --import ./evals/register.mjs evals/sensitive/run.ts [flags]
// Flags:
//   --only=slug,slug   run a subset of cases
//   --verbose          print the redacted output for every case

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sensitiveCorpus } from "./corpus";
import { frameCorpus } from "./frames";
import { scoreCase, scoreFrameCase, tally, type CaseScore } from "./score";

interface Flags {
  only: Set<string> | null;
  verbose: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { only: null, verbose: false };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) flags.only = new Set(arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--verbose") flags.verbose = true;
  }
  return flags;
}

const bar = "─".repeat(64);

function report(scores: CaseScore[], verbose: boolean): void {
  for (const s of scores) {
    const status = s.pass ? "PASS " : "FAIL ";
    console.error(`\n${s.pass ? "✓" : "✗"} ${s.id} — ${s.about}`);
    console.error(`   ${status} ${Math.round(s.score * 100)}% · ${s.matchCount} finding(s)`);
    for (const check of s.checks) {
      if (!check.pass) console.error(`     ✗ ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    if (verbose) console.error(`   → ${s.redacted}`);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const textCases = sensitiveCorpus.filter((c) => !flags.only || flags.only.has(c.id));
  const frameCases = frameCorpus.filter((c) => !flags.only || flags.only.has(c.id));
  if (textCases.length + frameCases.length === 0) {
    console.error("No cases matched", flags.only ? [...flags.only] : "");
    process.exit(2);
  }

  console.error(`\nSkill Recorder — sensitive detection + redaction evals`);
  console.error(`${textCases.length} text case(s) · ${frameCases.length} frame case(s)`);

  console.error(`${bar}\nText channels (secretlint + structured PII → redaction)`);
  const textScores: CaseScore[] = [];
  for (const c of textCases) textScores.push(await scoreCase(c));
  report(textScores, flags.verbose);

  console.error(`\n${bar}\nFrame channel (OCR words → detectors → blur boxes)`);
  const frameScores: CaseScore[] = [];
  for (const c of frameCases) frameScores.push(await scoreFrameCase(c));
  report(frameScores, flags.verbose);

  const scores = [...textScores, ...frameScores];
  const totals = tally(scores);
  const pct = (n: number, d: number): string => (d ? `${Math.round((n / d) * 100)}%` : "  — ");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(process.cwd(), "evals", "results", `sensitive-${stamp}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ at: stamp, totals, scores }, null, 2));

  console.error(`\n${bar}\nSummary`);
  const passed = scores.filter((s) => s.pass).length;
  for (const s of scores) {
    console.error(`  ${s.pass ? "PASS " : "FAIL "} ${Math.round(s.score * 100).toString().padStart(3)}%  ${s.id}`);
  }
  console.error(
    `\n  recall (sensitive detail masked/blurred):  ${totals.recallPass}/${totals.recallTotal}  ${pct(totals.recallPass, totals.recallTotal)}`,
  );
  console.error(
    `  precision (ordinary content kept):         ${totals.precisionPass}/${totals.precisionTotal}  ${pct(totals.precisionPass, totals.precisionTotal)}`,
  );
  console.error(`\n  ${passed}/${scores.length} cases passed`);
  console.error(`  results: ${path.relative(process.cwd(), outFile)}\n`);

  process.exit(passed === scores.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(3);
});
