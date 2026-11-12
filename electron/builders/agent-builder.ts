import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";

import { aiConnection, connectAiClient, type AiRuntimeConfig } from "../ai-provider";
import { createLogger } from "../logger";

/**
 * Shared plumbing for the final-stage, multi-turn Copilot builders (Skill Builder
 * and Automation Builder). Owns one lazily-started {@link CopilotClient} and a small
 * pool of live conversations — one per recording — so each build's plan → refine →
 * create flow stays in a single session. Subclasses add the build-specific tools,
 * system prompt, and `build`/`create` turns; everything below is common.
 */

/** The minimum every live build carries so the pool can manage it. */
export interface BaseLive {
  sessionId: string;
  copilot: CopilotSession;
}

const MAX_LIVE_SESSIONS = 4;

export abstract class AgentBuilder<TLive extends BaseLive> {
  private client: CopilotClient | null = null;
  private clientStart: Promise<CopilotClient> | null = null;
  protected model: string | undefined;
  protected runtime: AiRuntimeConfig | undefined;
  protected readonly live = new Map<string, TLive>();
  protected readonly active = new Set<string>();
  protected readonly log;

  /** @param name Used for logs and the "not signed in" / startup-timeout messages. */
  constructor(
    private readonly name: string,
    private readonly connection: () => Promise<AiRuntimeConfig> = () => aiConnection.configuration(),
  ) {
    this.log = createLogger(name);
  }

  isBuilding(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) await live.copilot.abort().catch(() => undefined);
  }

  async forget(sessionId: string): Promise<void> {
    await this.disposeLive(sessionId);
  }

  async evictIdle(): Promise<void> {
    for (const [id, live] of this.live) {
      if (this.active.has(id)) continue;
      this.live.delete(id);
      await live.copilot.disconnect().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    for (const [id] of this.live) await this.disposeLive(id);
    if (this.client) await this.client.forceStop();
    this.client = null;
    this.clientStart = null;
    this.model = undefined;
    this.runtime = undefined;
  }

  /** Start (once) with the selected connection; verify sign-in only in GitHub mode. */
  protected async ensureClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.clientStart) return this.clientStart;
    this.clientStart = (async () => {
      this.runtime = await this.connection();
      const client = await connectAiClient(this.runtime, `Copilot CLI (${this.name})`);
      this.model = this.runtime.byom ? this.runtime.session.model : process.env.SKILL_RECORDER_MODEL || undefined;
      this.log.info("AI connection ready", this.runtime.byom ? "BYOM" : "GitHub");
      this.client = client;
      return client;
    })();
    try {
      return await this.clientStart;
    } catch (err) {
      this.clientStart = null;
      throw err;
    }
  }

  /** Add a freshly created live session to the pool, evicting the oldest idle one
   *  when the pool is over budget. */
  protected registerLive(live: TLive): void {
    this.live.set(live.sessionId, live);
    for (const [id, l] of this.live) {
      if (this.live.size <= MAX_LIVE_SESSIONS) break;
      if (id === live.sessionId || this.active.has(id)) continue;
      this.live.delete(id);
      void l.copilot.disconnect().catch(() => undefined);
    }
  }

  protected async disposeLive(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    await live.copilot.disconnect().catch(() => undefined);
  }
}
