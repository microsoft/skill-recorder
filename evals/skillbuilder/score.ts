// Deterministic, LLM-free scoring for the skill builder evals.
//
// Where the automation scorer only checks native-tool choice over free-text step
// prompts, a SkillPlan is structured — so we score both the tool choice AND the
// shape the builder is now supposed to produce: genuinely fixed literals pulled out
// as `values` (with every `{{token}}` a step references resolving to one), and an
// ordered procedure split into calculations and actions. Each is a cheap, exact check
// so a run is repeatable and a failure names the missing piece.

import type { SkillPlan } from "../../common/skill";
import { unresolvedTokens } from "../../common/values";
import type { SkillRubric } from "./scenario";

export interface SkillCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface SkillScoreResult {
  pass: boolean;
  score: number;
  checks: SkillCheck[];
}

const has = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/** All the text a native-tool check looks at: every step's text + tools, plus allowed-tools. */
function toolText(plan: SkillPlan): string {
  const steps = plan.steps.map((s) => `${s.text} ${s.tools.join(" ")}`).join("\n");
  return `${steps}\n${plan.allowedTools.join(" ")}`;
}

export function scoreSkill(plan: SkillPlan, rubric: SkillRubric): SkillScoreResult {
  const checks: SkillCheck[] = [];
  const text = toolText(plan);

  for (const group of rubric.mustUseAny) {
    const hit = group.find((k) => has(text, k));
    checks.push({
      name: `uses one of: ${group.map((k) => JSON.stringify(k)).join(", ")}`,
      pass: Boolean(hit),
      detail: hit ? `found ${JSON.stringify(hit)}` : "none of these appeared in the plan",
    });
  }

  for (const bad of rubric.forbidden) {
    const present = has(text, bad);
    checks.push({
      name: `avoids ${JSON.stringify(bad)}`,
      pass: !present,
      detail: present ? `forbidden token ${JSON.stringify(bad)} appeared in the plan` : undefined,
    });
  }

  // Values: at least N declared, and every {{token}} used in a step resolves to one.
  const minValues = rubric.minValues ?? 0;
  checks.push({
    name: `declares >= ${minValues} value(s)`,
    pass: plan.values.length >= minValues,
    detail: `found ${plan.values.length}`,
  });
  const unresolved = [...new Set(plan.steps.flatMap((s) => unresolvedTokens(s.text, plan.values)))];
  checks.push({
    name: "every {{token}} in steps resolves to a value",
    pass: unresolved.length === 0,
    detail: unresolved.length ? `unresolved: ${unresolved.map((t) => `{{${t}}}`).join(", ")}` : undefined,
  });

  // Steps: split into calculations and actions.
  const calculations = plan.steps.filter((s) => s.kind === "calculation");
  const actions = plan.steps.filter((s) => s.kind === "action");
  const minCalculations = rubric.minCalculations ?? 1;
  const minActions = rubric.minActions ?? 1;
  checks.push({
    name: `has >= ${minCalculations} calculation step(s)`,
    pass: calculations.length >= minCalculations,
    detail: `found ${calculations.length}`,
  });
  checks.push({
    name: `has >= ${minActions} action step(s)`,
    pass: actions.length >= minActions,
    detail: `found ${actions.length}`,
  });

  // A forbidden-token hit (wrong tool) fails outright; otherwise every check must pass.
  const forbiddenHit = checks.some((c) => c.name.startsWith("avoids ") && !c.pass);
  const passed = checks.filter((c) => c.pass).length;
  const score = checks.length ? passed / checks.length : 0;
  return { pass: !forbiddenHit && passed === checks.length, score, checks };
}
