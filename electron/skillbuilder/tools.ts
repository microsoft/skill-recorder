import type { Tool } from "@github/copilot-sdk";

import {
  SkillPlanSchema,
  SkillSubmissionSchema,
  type SkillArchitecture,
  type SkillPlan,
  type SkillSubmission,
} from "../../common/skill";
import { validatePlanTooling } from "./plan-tools";

/** Everything the builder's skill-specific tools are bound to for one session. */
export interface SkillToolContext {
  architecture: SkillArchitecture;
  /** Streamed to the UI as the agent works. */
  onProgress?: (message: string) => void;
  /** Called when the agent proposes a (validated) plan for review. */
  onPlan: (plan: SkillPlan) => void;
  /** Called when the agent submits the final (validated) skill. */
  onSubmit: (submission: SkillSubmission) => void;
}

/**
 * Build the skill-specific tools exposed to one Skill Builder session. The agent
 * reads the recording via the shared read-tools (get_analysis / get_timeline), then
 * proposes a reviewable plan (propose_plan) and — once the user approves — submits
 * the final skill (submit_skill). Both submissions are zod-validated; the
 * architecture is injected server-side so the agent can't set it.
 */
export function createSkillBuilderTools(ctx: SkillToolContext): Tool[] {
  const { architecture, onPlan, onSubmit } = ctx;
  const progress = (m: string) => ctx.onProgress?.(m);

  const proposePlan: Tool = {
    name: "propose_plan",
    description:
      "Propose your reviewable plan for the skill: how you'll generalize the task, the fixed values it hard-codes (each a small id + human name + the literal, referenced from the steps by a {{id}} token), the ordered steps (each with a short title, a description, and every concrete native tool it uses in call order), and the allowed-tools. Call this once per turn, then STOP so the user can review or refine it. Do NOT write the skill body yet.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case skill id, e.g. \"submit-expense-records\"." },
        title: { type: "string", description: "Human-friendly title, e.g. \"Submit expense records\"." },
        description: {
          type: "string",
          description: "Trigger-oriented one-liner (becomes the SKILL.md description).",
        },
        summary: { type: "string", description: "Plain-language summary of what the skill does." },
        generalization: {
          type: "string",
          description:
            "How the recorded specifics become a repeatable procedure (the loop/collection insight).",
        },
        values: {
          type: "array",
          description:
            "Genuinely FIXED literals the procedure hard-codes — a canonical URL, file path, repo slug, or constant that is the SAME every run. Each becomes an inline, editable pill in the review UI and is substituted for its {{id}} token when the skill is written. Do NOT create a value for anything discovered at run time or that varies run-to-run — write those as plain step instructions.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "snake_case token key referenced in step text as {{id}}, e.g. \"backlog_url\".",
              },
              name: {
                type: "string",
                description: "Short human label shown on the pill, e.g. \"Blog Backlog v2 URL\".",
              },
              value: {
                type: "string",
                description: "The exact fixed literal (the URL / path / repo slug / constant).",
              },
            },
            required: ["id", "name", "value"],
            additionalProperties: false,
          },
        },
        steps: {
          type: "array",
          description:
            "The generalized procedure as ordered, typed steps. Give each a short title and a description, and tag it as a calculation (reads/derives/decides/formats — no external side effect) or an action (changes the world: submit/send/create/delete).",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["calculation", "action"],
                description: "calculation = no external effect; action = a side effect.",
              },
              title: {
                type: "string",
                description: "Short title/label for the step, e.g. \"List open PRs\".",
              },
              text: {
                type: "string",
                description:
                  "Imperative, generalized description of the step. Reference any fixed value by its {{id}} token instead of writing the literal (e.g. \"open {{backlog_url}} and read the table\").",
              },
              tools: {
                type: "array",
                items: { type: "string" },
                description:
                  "Every concrete runtime tool/skill this step calls, in order, e.g. [\"workiq_get_my_profile\", \"workiq_search_chats\"] or [\"bash\"]. Use lowercase runtime identifiers here; permission patterns belong only in allowedTools.",
              },
            },
            required: ["kind", "title", "text", "tools"],
            additionalProperties: false,
          },
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "allowed-tools frontmatter patterns, e.g. \"Bash(git *)\", \"Read\", \"Write\".",
        },
      },
      required: ["name", "title", "description"],
      additionalProperties: false,
    },
    handler: (raw) => {
      const merged = { ...(raw as Record<string, unknown>), architecture };
      const parsed = SkillPlanSchema.safeParse(merged);
      if (!parsed.success) {
        return {
          textResultForLlm:
            "propose_plan rejected — the payload did not match the schema. Fix these and call again:\n" +
            parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
          resultType: "failure",
        };
      }
      const toolingIssues = validatePlanTooling(parsed.data);
      if (toolingIssues.length) {
        return {
          textResultForLlm:
            "propose_plan rejected — fix the runtime tool identifiers and allowed-tools:\n" +
            toolingIssues.map((issue) => `- ${issue}`).join("\n"),
          resultType: "failure",
        };
      }
      progress("Proposed a plan for your review.");
      onPlan(parsed.data);
      return "Plan recorded and shown to the user. Stop now and wait for their review or refinement.";
    },
  };

  const submitSkill: Tool = {
    name: "submit_skill",
    description:
      "Submit the final skill AFTER the user approves the plan: the SKILL.md name, description, allowed-tools, and the markdown instructions body. The body must be a generalized, native-tool-first procedure written imperatively to the agent.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case skill id (matches the approved plan)." },
        description: { type: "string", description: "SKILL.md description (trigger keywords)." },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "allowed-tools frontmatter patterns.",
        },
        body: {
          type: "string",
          description:
            "The SKILL.md instructions body (markdown, everything after the frontmatter): when to use it, the generalized ordered procedure, and which native tools/skills to use. Reference each fixed value by its {{id}} token exactly (e.g. {{backlog_url}}) — never write the literal value yourself; it is substituted in when the skill is written.",
        },
      },
      required: ["name", "description", "body"],
      additionalProperties: false,
    },
    handler: (raw) => {
      const parsed = SkillSubmissionSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          textResultForLlm:
            "submit_skill rejected — the payload did not match the schema. Fix these and call again:\n" +
            parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
          resultType: "failure",
        };
      }
      progress("Received the finished skill.");
      onSubmit(parsed.data);
      return "Skill recorded. You may stop now.";
    },
  };

  return [proposePlan, submitSkill];
}
