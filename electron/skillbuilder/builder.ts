import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { approveAll, type CopilotSession } from "@github/copilot-sdk";

import {
  BuiltSkillSchema,
  renderSkillMarkdown,
  requireTargetPlacement,
  SkillPlanSchema,
  slugifySkillName,
  toBuiltSkill,
  type BuiltSkill,
  type SkillArchitecture,
  type SkillPlan,
  type SkillSubmission,
} from "../../common/skill";
import { unresolvedTokens } from "../../common/values";
import type { SkillBuildInput, SkillBuildProgress, SkillPreview } from "../../common/ipc";
import { requireCatalogue } from "../architectures/catalogue-registry";
import { AgentBuilder, type BaseLive } from "../builders/agent-builder";
import { createReadTools } from "../builders/read-tools";
import { loadPersistedAnalysis } from "../describer/describer";
import { createLogger } from "../logger";
import { isValidSessionId, sessionDir } from "../recorder/session-store";
import { SKILL_BUILDER_INSTRUCTIONS } from "./instructions";
import { createSkillBuilderTools } from "./tools";

const log = createLogger("SkillBuilder");

const TURN_TIMEOUT_MS = 180_000;
const MAX_PREVIEWS = 4;

const KICKOFF_PROMPT =
  "Read get_analysis (and get_timeline where the tool mapping needs evidence), then call " +
  "propose_plan with how you'll generalize this task, its fixed values (each an id + name + " +
  "value, referenced from steps as {{id}}), and its ordered steps (each a short title + " +
  "description, with every concrete native tool it calls). Stop after propose_plan so the user can review it.";

const CREATE_PROMPT =
  "The user reviewed and edited the plan below. Build the SKILL.md from EXACTLY this plan — do not " +
  "add, drop, reorder, or rename its values or steps. Call submit_skill with a generalized, " +
  "native-tool-first instructions body that follows these steps faithfully and references each fixed " +
  "value by its {{id}} token (never inline the literal). The name and description are already decided — " +
  "you may echo them.";

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Root folder Scout auto-loads user skills from (overridable for dev/tests). */
function skillsRoot(): string {
  const override = process.env.SKILL_RECORDER_SKILLS_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".copilot", "skills");
}

/** True when `dir` is `root` or nested inside it (so we can safely re-use it). */
export function isInside(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Where {@link SkillBuilder.create} writes the finished SKILL.md:
 * - **install** — into the agent's live skills folder ({@link skillsRoot}), auto-loaded.
 * - **export** — into a user-picked folder (a "download"), as `<dir>/<name>/SKILL.md`.
 */
export type SkillTarget = { kind: "install" } | { kind: "export"; dir: string };
type SkillTargetPicker = () => Promise<SkillTarget | null>;

interface PreparedSkill extends SkillPreview {
  skill: BuiltSkill;
  planKey: string;
}

interface BuildOperation {
  canceled: boolean;
}

export class SkillPreviewExpiredError extends Error {
  constructor() {
    super("This skill preview is no longer current. Review the skill again before placing it.");
    this.name = "SkillPreviewExpiredError";
  }
}

interface LiveBuild extends BaseLive {
  sessionDir: string;
  architecture: SkillArchitecture;
  copilot: CopilotSession;
  holder: { plan: SkillPlan | undefined; submission: SkillSubmission | undefined };
  /** Last plan proposed this build (kept so submit can reference it). */
  lastPlan: SkillPlan | null;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Load a previously built + persisted skill for a session, if any. */
export function loadPersistedSkill(sessionId: string): BuiltSkill | null {
  if (!isValidSessionId(sessionId)) return null;
  const raw = readJson<unknown>(path.join(sessionDir(sessionId), "skill.json"));
  if (!raw) return null;
  const parsed = BuiltSkillSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Drives the multi-turn GitHub Copilot CLI agent that turns a recording's analysis
 * into a generalized, native-tool-first skill for a target architecture. Shares the
 * {@link AgentBuilder} pool (one live conversation per recording) so the plan →
 * refine → build flow stays in a single session. Streams progress out via a
 * callback and writes the final SKILL.md into the target agent's skills folder.
 */
export class SkillBuilder extends AgentBuilder<LiveBuild> {
  private readonly previews = new Map<string, PreparedSkill>();
  private readonly operations = new Map<string, BuildOperation>();

  constructor(private readonly emitProgress: (p: SkillBuildProgress) => void) {
    super("SkillBuilder");
  }

  /** Propose a plan (first pass) or refine the current one with NL feedback. */
  async build(input: SkillBuildInput): Promise<SkillPlan> {
    const { sessionId, architecture, feedback } = input;
    if (this.active.has(sessionId)) throw new Error("A build is already running for this session.");
    requireCatalogue(architecture, "skill");
    const analysis = loadPersistedAnalysis(sessionId);
    if (!analysis) throw new Error("There is no analysis for this recording yet.");

    const operation = this.begin(sessionId);
    this.discardPreview(sessionId);
    try {
      const refining = Boolean(feedback && feedback.trim());
      this.emit(sessionId, "start", refining ? "Refining the plan…" : "Planning the skill…");
      let live = this.live.get(sessionId);
      if (!refining || !live) {
        await this.disposeLive(sessionId); // fresh conversation for a fresh plan
        live = await this.createLive(sessionId, architecture);
      }
      const prompt = refining ? renderRefinePrompt(feedback!.trim(), live.lastPlan) : KICKOFF_PROMPT;
      this.requireActive(operation);
      return await this.runProposeTurn(live, prompt, operation);
    } finally {
      this.finish(sessionId);
    }
  }

  /** Prepare the exact file for optional review, without writing or placing it. */
  async prepare(sessionId: string, editedPlan: SkillPlan): Promise<SkillPreview> {
    const plan = SkillPlanSchema.parse(editedPlan);
    const operation = this.begin(sessionId);
    try {
      let prepared = this.previews.get(sessionId);
      if (!prepared || prepared.planKey !== JSON.stringify(plan)) {
        this.discardPreview(sessionId);
        prepared = await this.generate(sessionId, plan, operation);
        this.requireActive(operation);
        this.previews.set(sessionId, prepared);
        while (this.previews.size > MAX_PREVIEWS) {
          const oldest = this.previews.keys().next().value;
          if (oldest === undefined) break;
          this.previews.delete(oldest);
        }
      }
      this.emit(sessionId, "done", "Skill ready for review. Nothing has been installed.");
      return { id: prepared.id, markdown: prepared.markdown };
    } finally {
      this.finish(sessionId);
    }
  }

  discardPreview(sessionId: string, previewId?: string): void {
    if (previewId === undefined || this.previews.get(sessionId)?.id === previewId) {
      this.previews.delete(sessionId);
    }
  }

  override async cancel(sessionId: string): Promise<void> {
    const operation = this.operations.get(sessionId);
    if (operation) operation.canceled = true;
    await super.cancel(sessionId);
  }

  override async forget(sessionId: string): Promise<void> {
    this.discardPreview(sessionId);
    await this.cancel(sessionId);
    await super.forget(sessionId);
  }

  override async dispose(): Promise<void> {
    for (const operation of this.operations.values()) operation.canceled = true;
    this.previews.clear();
    await super.dispose();
  }

  /** Place a reviewed candidate, or generate and place in one step for direct callers.
   *  The picker runs under the operation guard, before any direct-path generation. */
  async create(
    sessionId: string,
    editedPlan?: SkillPlan,
    target: SkillTarget | SkillTargetPicker = { kind: "install" },
    previewId?: string,
  ): Promise<{ skill: BuiltSkill; path: string } | null> {
    const plan = editedPlan
      ? SkillPlanSchema.parse(editedPlan)
      : this.live.get(sessionId)?.lastPlan ?? null;
    if (!plan) throw new Error("There is no plan to build from yet.");
    const operation = this.begin(sessionId);
    try {
      let prepared = previewId === undefined ? undefined : this.requirePreview(sessionId, plan, previewId);
      const destination = typeof target === "function" ? await target() : target;
      this.requireActive(operation);
      if (!destination) return null;
      requireTargetPlacement(plan.architecture, "skill", destination.kind);
      if (previewId !== undefined) {
        // The folder picker can outlive a discarded or replaced preview.
        prepared = this.requirePreview(sessionId, plan, previewId);
      } else {
        this.discardPreview(sessionId);
        prepared = await this.generate(sessionId, plan, operation);
      }
      this.requireActive(operation);
      if (!prepared) throw new Error("There is no prepared skill to place.");
      const exportPath =
        destination.kind === "export"
          ? this.exportSkillTo(prepared.skill, destination.dir, prepared.markdown)
          : this.exportSkill(prepared.skill, prepared.markdown);
      const finalSkill: BuiltSkill = { ...prepared.skill, exportedPath: exportPath, exportedAt: Date.now() };
      this.persist(sessionDir(sessionId), finalSkill);
      this.discardPreview(sessionId);
      this.emit(
        sessionId,
        "done",
        destination.kind === "export" ? `Skill exported to ${exportPath}` : `Skill added: ${exportPath}`,
      );
      return { skill: finalSkill, path: exportPath };
    } finally {
      this.finish(sessionId);
    }
  }

  // --- internals -----------------------------------------------------------

  private begin(sessionId: string): BuildOperation {
    if (this.active.has(sessionId)) throw new Error("Wait for the current step to finish.");
    const operation: BuildOperation = { canceled: false };
    this.active.add(sessionId);
    this.operations.set(sessionId, operation);
    return operation;
  }

  private finish(sessionId: string): void {
    this.operations.delete(sessionId);
    this.active.delete(sessionId);
  }

  private requireActive(operation: BuildOperation): void {
    if (operation.canceled) throw new Error("Skill build canceled.");
  }

  private requirePreview(sessionId: string, plan: SkillPlan, id: string): PreparedSkill {
    const prepared = this.previews.get(sessionId);
    if (!prepared || prepared.id !== id || prepared.planKey !== JSON.stringify(plan)) {
      throw new SkillPreviewExpiredError();
    }
    return prepared;
  }

  private async generate(
    sessionId: string,
    plan: SkillPlan,
    operation: BuildOperation,
  ): Promise<PreparedSkill> {
    let live = this.live.get(sessionId);
    if (live && live.architecture !== plan.architecture) {
      await this.disposeLive(sessionId);
      live = undefined;
    }
    this.requireActive(operation);
    if (!live) live = await this.createLive(sessionId, plan.architecture);
    this.requireActive(operation);
    live.lastPlan = plan;
    this.emit(sessionId, "drafting", "Writing the skill…");
    live.holder.submission = undefined;
    try {
      await live.copilot.sendAndWait(`${CREATE_PROMPT}\n\n${renderPlanForPrompt(plan)}`, TURN_TIMEOUT_MS);
    } catch (err) {
      await live.copilot.abort().catch(() => undefined);
      throw new Error(`Skill build failed: ${msg(err)}`);
    }
    this.requireActive(operation);
    const submission = live.holder.submission as SkillSubmission | undefined;
    if (!submission) throw new Error("The agent finished without submitting a skill.");
    const unknownTokens = unresolvedTokens(submission.body, plan.values);
    if (unknownTokens.length) {
      log.warn(`skill body references unknown value tokens: ${unknownTokens.map((t) => `{{${t}}}`).join(", ")}`);
    }
    const finalSubmission: SkillSubmission = {
      name: plan.name,
      description: plan.description,
      allowedTools: submission.allowedTools.length ? submission.allowedTools : plan.allowedTools,
      body: submission.body,
    };
    const skill = toBuiltSkill(sessionId, plan.architecture, finalSubmission, plan);
    return { id: randomUUID(), skill, planKey: JSON.stringify(plan), markdown: renderSkillMarkdown(skill) };
  }

  private emit(sessionId: string, phase: SkillBuildProgress["phase"], message: string): void {
    this.emitProgress({ sessionId, phase, message });
  }

  private async createLive(sessionId: string, architecture: SkillArchitecture): Promise<LiveBuild> {
    const dir = sessionDir(sessionId);
    const analysis = loadPersistedAnalysis(sessionId);
    if (!analysis) throw new Error("There is no analysis for this recording yet.");

    const holder: LiveBuild["holder"] = { plan: undefined, submission: undefined };
    const tools = [
      ...createReadTools({
        sessionDir: dir,
        analysis,
        onProgress: (m) => this.emit(sessionId, "working", m),
      }),
      ...createSkillBuilderTools({
        architecture,
        onProgress: (m) => this.emit(sessionId, "working", m),
        onPlan: (p) => {
          holder.plan = p;
        },
        onSubmit: (s) => {
          holder.submission = s;
        },
      }),
    ];

    const catalogue = requireCatalogue(architecture, "skill").content;
    const systemContent = `${SKILL_BUILDER_INSTRUCTIONS}\n\n${catalogue}`.trim();

    const client = await this.ensureClient();
    const copilot = await client.createSession({
      systemMessage: { mode: "append", content: systemContent },
      tools,
      onPermissionRequest: approveAll,
      workingDirectory: dir,
      enableHostGitOperations: false,
      infiniteSessions: { enabled: false },
      availableTools: tools.map((t) => t.name),
      ...(this.model ? { model: this.model } : {}),
    });

    const live: LiveBuild = {
      sessionId,
      sessionDir: dir,
      architecture,
      copilot,
      holder,
      lastPlan: null,
    };
    this.registerLive(live);
    return live;
  }

  private async runProposeTurn(
    live: LiveBuild,
    prompt: string,
    operation: BuildOperation,
  ): Promise<SkillPlan> {
    live.holder.plan = undefined;
    this.emit(live.sessionId, "working", "Thinking…");
    try {
      await live.copilot.sendAndWait(prompt, TURN_TIMEOUT_MS);
    } catch (err) {
      await live.copilot.abort().catch(() => undefined);
      throw new Error(`Planning failed: ${msg(err)}`);
    }
    this.requireActive(operation);
    const plan = live.holder.plan;
    if (!plan) throw new Error("The agent finished without proposing a plan.");
    live.lastPlan = plan;
    this.emit(live.sessionId, "done", "Plan ready for your review.");
    return plan;
  }

  /** Write the SKILL.md into the target agent's live skills folder; returns its path. */
  private exportSkill(skill: BuiltSkill, markdown: string): string {
    const root = skillsRoot();
    const name = slugifySkillName(skill.name);
    const prior = loadPersistedSkill(skill.sessionId);
    const priorDir = prior?.exportedPath ? path.dirname(prior.exportedPath) : null;
    // Re-install over the same folder only when it already lives under the install root;
    // a prior *export* (download) folder must not be reused here. Otherwise pick a fresh,
    // non-colliding directory so we never clobber an unrelated skill.
    const reuse = priorDir !== null && isInside(root, priorDir);
    let dir = reuse ? (priorDir as string) : path.join(root, name);
    if (!reuse && existsSync(dir)) {
      let n = 2;
      while (existsSync(path.join(root, `${name}-${n}`))) n++;
      dir = path.join(root, `${name}-${n}`);
    }
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    writeFileSync(file, markdown);
    return file;
  }

  /** Export (download) the SKILL.md into a user-picked folder as `<baseDir>/<name>/SKILL.md`;
   *  returns its path. Always picks a fresh, non-colliding subfolder within `baseDir`. */
  private exportSkillTo(skill: BuiltSkill, baseDir: string, markdown: string): string {
    const name = slugifySkillName(skill.name);
    let dir = path.join(baseDir, name);
    if (existsSync(dir)) {
      let n = 2;
      while (existsSync(path.join(baseDir, `${name}-${n}`))) n++;
      dir = path.join(baseDir, `${name}-${n}`);
    }
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    writeFileSync(file, markdown);
    return file;
  }

  private persist(dir: string, skill: BuiltSkill): void {
    try {
      writeFileSync(path.join(dir, "skill.json"), JSON.stringify(skill, null, 2));
    } catch (err) {
      log.warn("failed to persist skill:", msg(err));
    }
  }
}

/** Render the final, user-edited plan into a compact spec the create turn builds from. */
function renderPlanForPrompt(plan: SkillPlan): string {
  const lines = [`Title: ${plan.title}`, `Name: ${plan.name}`, `Description: ${plan.description}`];
  if (plan.generalization) lines.push(`Generalization: ${plan.generalization}`);
  if (plan.values.length) {
    lines.push(
      "",
      "Values (reference each by its {{id}} token in the body — never write the literal value yourself):",
    );
    for (const v of plan.values) lines.push(`- {{${v.id}}}${v.name ? ` — ${v.name}` : ""}`);
  }
  if (plan.steps.length) {
    lines.push("", "Steps (in order):");
    plan.steps.forEach((s, idx) => {
      const head = [s.title, s.text].filter(Boolean).join(" — ");
      const bits = [`${idx + 1}. (${s.kind}) ${head}`];
      if (s.tools.length) bits.push(`[tools: ${s.tools.join(" → ")}]`);
      lines.push(bits.join(" "));
    });
  }
  if (plan.allowedTools.length) lines.push("", `allowed-tools: ${plan.allowedTools.join(", ")}`);
  return lines.join("\n");
}

function renderRefinePrompt(feedback: string, prior: SkillPlan | null): string {
  const lines = [
    "The user reviewed your proposed plan and wants changes. Revise the plan and call",
    "propose_plan again (do not write the skill yet).",
    "",
  ];
  if (prior) {
    lines.push(`Current plan: ${prior.title} (${prior.name})`);
    lines.push(`- generalization: ${prior.generalization || "(none)"}`);
    if (prior.values.length) {
      lines.push(`- values: ${prior.values.map((v) => v.name || v.id).join(", ")}`);
    }
    lines.push("");
  }
  lines.push(`Their feedback: ${feedback}`);
  return lines.join("\n");
}
