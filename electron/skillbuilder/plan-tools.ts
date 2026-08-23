import type { SkillPlan } from "../../common/skill";
import { SCOUT_PLAN_TOOL_IDS } from "../architectures/catalogues/scout-catalogue";

const SCOUT_TOOLS = new Set<string>(SCOUT_PLAN_TOOL_IDS);

/** Validate runtime identifiers independently from frontmatter permission patterns. */
export function validatePlanTooling(plan: SkillPlan): string[] {
  if (plan.architecture !== "scout") return [];

  const issues: string[] = [];
  const tools = new Set(plan.steps.flatMap((step) => step.tools));
  for (const tool of tools) {
    if (!SCOUT_TOOLS.has(tool)) {
      issues.push(`Unknown Scout runtime tool or skill ${JSON.stringify(tool)}.`);
    }
  }

  const permissions = new Set(plan.allowedTools);
  for (const [tool, permission] of [
    ["view", "Read"],
    ["glob", "Glob"],
    ["grep", "Grep"],
  ] as const) {
    if (tools.has(tool) && !permissions.has(permission)) {
      issues.push(`Runtime tool ${JSON.stringify(tool)} requires allowedTools to include ${JSON.stringify(permission)}.`);
    }
  }
  if (tools.has("bash") && !plan.allowedTools.some((permission) => /^Bash\(.+\)$/.test(permission))) {
    issues.push('Runtime tool "bash" requires a scoped allowedTools pattern such as "Bash(gh *)".');
  }

  return issues;
}
