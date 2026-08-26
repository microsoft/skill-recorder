import { z } from "zod";

import { SkillArchitecture } from "./architecture-registry";
import { migrateLegacyInputsToValues, renderValues, ValueSchema } from "./values";

export * from "./architecture-registry";

/**
 * The Skill Builder's contract. From an *approved* {@link Analysis} the multi-turn
 * Copilot agent first proposes a **plan** ({@link SkillPlan}) — how it will
 * generalize the recorded task, what fixed values it needs, and which of the target
 * architecture's native tools it will use — which the user refines in natural
 * language. On confirmation the agent submits the final **built skill**
 * ({@link BuiltSkill}), which is rendered to a `SKILL.md` and exported into the
 * target agent (Scout first). Kept separate from `analysis.ts` (the builder's
 * *input*); this is the builder's *output*.
 */

/**
 * A generalized step is either a **calculation** (reads, derives, decides, or formats
 * — no external side effect) or an **action** (changes the world: submit, send, create,
 * delete). Splitting them keeps the plan honest about side effects; the actions are the
 * risky surface.
 */
export const PlanStepKind = z.enum(["calculation", "action"]);
export type PlanStepKind = z.infer<typeof PlanStepKind>;

export const PlanStepSchema = z.preprocess(
  // Earlier plans stored steps as bare strings; surface those as (visible) actions.
  (v) => (typeof v === "string" ? { kind: "action", text: v } : v),
  z.object({
    kind: PlanStepKind,
    /** Short title/label for the step, e.g. "List open PRs". */
    title: z.string().default(""),
    /** Imperative, generalized description of the step. */
    text: z.string(),
    /** The native tool/skill this step uses, if any (e.g. "workiq_search_chats"). */
    tool: z.string().default(""),
  }),
);
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * The agent's proposed plan, shown to the user before any skill is written.
 * This is what `propose_plan` submits and what the user refines in NL.
 */
export const SkillPlanSchema = z.preprocess(
  migrateLegacyInputsToValues,
  z.object({
  /** Target architecture this plan is written for. */
  architecture: SkillArchitecture,
  /** kebab-case skill id, e.g. "submit-expense-records". */
  name: z.string().transform(slugifySkillName),
  /** Human-friendly title, e.g. "Submit expense records". */
  title: z.string(),
  /** Trigger-oriented description (becomes the SKILL.md `description`). */
  description: z.string(),
  /** Plain-language summary of what the skill does. */
  summary: z.string().default(""),
  /** How the recorded specifics are generalized (the loop/collection insight). */
  generalization: z.string().default(""),
  /** Named fixed literals (URLs / paths / constants) the steps reference by `{{id}}`. */
  values: z.array(ValueSchema).default([]),
  /** The generalized procedure as ordered, typed steps (calculations + actions). */
  steps: z.array(PlanStepSchema).default([]),
  /** Proposed `allowed-tools` frontmatter patterns, e.g. "Bash(git *)". */
  allowedTools: z.array(z.string()).default([]),
  }),
);
export type SkillPlan = z.infer<typeof SkillPlanSchema>;

/**
 * The payload the agent submits via `submit_skill` once the plan is approved.
 * The engine renders this into `SKILL.md` and wraps it into a {@link BuiltSkill}.
 */
export const SkillSubmissionSchema = z.object({
  /** kebab-case skill id. */
  name: z.string().transform(slugifySkillName),
  /** SKILL.md `description` (trigger keywords). */
  description: z.string(),
  /** `allowed-tools` frontmatter patterns. */
  allowedTools: z.array(z.string()).default([]),
  /** The markdown instructions body (everything after the frontmatter). */
  body: z.string(),
});
export type SkillSubmission = z.infer<typeof SkillSubmissionSchema>;

/** The full, persisted result of a build for a session. */
export const BuiltSkillSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  architecture: SkillArchitecture,
  name: z.string(),
  description: z.string(),
  allowedTools: z.array(z.string()).default([]),
  /** The markdown instructions body. */
  body: z.string(),
  /** Fixed values substituted into the body at render time (the pill literals). */
  values: z.array(ValueSchema).default([]),
  /** The plan the skill was built from (for the UI / re-export). */
  plan: SkillPlanSchema.nullable().default(null),
  createdAt: z.number(),
  /** Absolute path of the exported SKILL.md, once exported. */
  exportedPath: z.string().optional(),
  exportedAt: z.number().optional(),
});
export type BuiltSkill = z.infer<typeof BuiltSkillSchema>;

/** Coerce arbitrary text into a safe kebab-case skill name Scout will accept. */
export function slugifySkillName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "recorded-skill";
}

/** Build a full BuiltSkill from an agent submission + engine-managed fields. */
export function toBuiltSkill(
  sessionId: string,
  architecture: SkillArchitecture,
  submission: SkillSubmission,
  plan: SkillPlan | null,
): BuiltSkill {
  return BuiltSkillSchema.parse({
    version: 1,
    sessionId,
    architecture,
    name: slugifySkillName(submission.name),
    description: submission.description,
    allowedTools: submission.allowedTools,
    body: submission.body,
    values: plan?.values ?? [],
    plan,
    createdAt: Date.now(),
  });
}

/**
 * Render a {@link BuiltSkill} to the exact `SKILL.md` text Scout parses:
 * YAML frontmatter (`name`, `description`, optional `allowed-tools`) followed by
 * the instructions body, with each `{{id}}` value token substituted for its literal.
 * The description is emitted as a double-quoted scalar so colons/commas in it never
 * break the YAML.
 */
export function renderSkillMarkdown(skill: BuiltSkill): string {
  const lines: string[] = ["---", `name: ${slugifySkillName(skill.name)}`];
  // JSON.stringify yields a valid YAML double-quoted scalar for normal text.
  lines.push(`description: ${JSON.stringify(skill.description.trim())}`);
  const tools = skill.allowedTools.map((t) => t.trim()).filter(Boolean);
  if (tools.length) {
    lines.push("allowed-tools:");
    for (const t of tools) lines.push(`  - ${t}`);
  }
  lines.push("---", "");
  lines.push(renderValues(skill.body, skill.values).trim(), "");
  return lines.join("\n");
}
