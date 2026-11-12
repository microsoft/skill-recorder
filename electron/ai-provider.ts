import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { app, safeStorage } from "electron";
import { approveAll, CopilotClient, type CopilotClientOptions, type SessionConfig } from "@github/copilot-sdk";
import sharp from "sharp";

import {
  AI_SETUP_REQUIRED, AiConnectionError, aiConnectionReady, parseApiKey, parseByomConfig,
  type AiConnectionResult, type AiConnectionStatus, type ByomConfig,
} from "../common/ai-provider";
import { COPILOT_SIGNED_OUT_ERROR, type CopilotSignInResult } from "../common/ipc";
import { AiProviderStore, secureStorageAvailable } from "./ai-provider-store";
import { copilotConnectionOption, withStartupTimeout } from "./copilot-cli-path";
import { abortable } from "./copilot-signin-flow";

export interface AiRuntimeConfig {
  client: CopilotClientOptions;
  session: Pick<SessionConfig, "provider" | "model" | "modelCapabilities">;
  byom: boolean;
}

export const githubRuntimeConfig = (): AiRuntimeConfig => ({
  byom: false, client: copilotConnectionOption() ?? {}, session: {},
});

export async function connectAiClient(config: AiRuntimeConfig, label: string): Promise<CopilotClient> {
  const client = new CopilotClient(config.client);
  try {
    await withStartupTimeout(client.start(), label);
    if (!config.byom && !(await client.getAuthStatus()).isAuthenticated) {
      throw new Error(COPILOT_SIGNED_OUT_ERROR);
    }
    return client;
  } catch (error) {
    await client.forceStop();
    throw config.byom ? providerError(error) : error;
  }
}

export async function createAiSession(client: CopilotClient, config: SessionConfig, runtime?: AiRuntimeConfig) {
  try { return await client.createSession({ ...config, ...runtime?.session }); }
  catch (error) { throw runtime?.byom ? providerError(error) : error; }
}

export function byomRuntimeConfig(profile: ByomConfig, key: string, baseDirectory: string): AiRuntimeConfig {
  const env = { ...process.env };
  // BYOM must neither depend on ambient GitHub credentials nor accidentally use them.
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN", "COPILOT_SDK_AUTH_TOKEN"]) delete env[name];
  return {
    byom: true,
    client: {
      ...copilotConnectionOption(), mode: "empty", useLoggedInUser: false,
      logLevel: "none", baseDirectory, workingDirectory: baseDirectory, env,
    },
    session: {
      model: profile.model,
      // Custom deployment names have no Copilot capability metadata. The connection
      // probe verifies this requirement before a profile can be saved.
      modelCapabilities: { supports: { vision: true } },
      provider: {
        type: profile.provider === "azure" ? "azure" : profile.provider === "anthropic" ? "anthropic" : "openai",
        baseUrl: profile.baseUrl,
        apiKey: key,
        ...(profile.provider === "anthropic" ? {} : { wireApi: profile.wireApi }),
        ...(profile.provider === "azure" ? { azure: { apiVersion: profile.apiVersion } } : {}),
      },
    },
  };
}

/** Deliberately authored errors: never return/log provider response bodies or credentials. */
export function providerError(error: unknown): AiConnectionError {
  if (error instanceof AiConnectionError) return error;
  const text = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b|unauthoriz|forbidden|invalid.*key|authentication/i.test(text)) {
    return new AiConnectionError("authentication", "The provider rejected the API key or access. Check the key and deployment permissions.");
  }
  if (/\b429\b|quota|rate.?limit/i.test(text)) {
    return new AiConnectionError("quota", "The provider's quota or rate limit was reached. Check billing or try again later.");
  }
  if (/\b404\b|deployment.*not.*found|model.*not.*found/i.test(text)) {
    return new AiConnectionError("model", "The provider could not find this model or deployment. Check its name and endpoint.");
  }
  if (/\b400\b|unsupported|image|vision|tool|protocol/i.test(text)) {
    return new AiConnectionError("capability", "The model or API format is incompatible. Check image input, tool calling, and the selected API format.");
  }
  return new AiConnectionError("connection", "The provider request failed or timed out. Check the endpoint, connection, and model, then try again.");
}

export async function testByomConnection(config: AiRuntimeConfig, signal: AbortSignal): Promise<void> {
  const client = new CopilotClient(config.client);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const code = String(randomInt(100_000, 1_000_000));
  let imageRead = false;
  let verified = false;
  try {
    await abortable(client.start(), bounded);
    const image = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="100"><rect width="360" height="100" fill="white"/><text x="20" y="68" font-family="sans-serif" font-size="54" letter-spacing="5" fill="black">${code}</text></svg>`,
    )).png().toBuffer();
    const session = await abortable(client.createSession({
      ...config.session,
      onPermissionRequest: approveAll,
      enableHostGitOperations: false,
      infiniteSessions: { enabled: false },
      availableTools: ["check_connection"],
      tools: [{
        name: "check_connection",
        description: "Call without a code to view a test image. Then call with the six-digit code you see.",
        parameters: {
          type: "object", properties: { code: { type: "string", pattern: "^[0-9]{6}$" } },
          additionalProperties: false,
        },
        handler: (input: unknown) => {
          if (typeof input === "object" && input !== null && "code" in input) {
            verified = imageRead && input.code === code;
            return { resultType: "success", textResultForLlm: "Test finished." };
          }
          imageRead = true;
          return {
            resultType: "success",
            textResultForLlm: "Inspect this synthetic image, then call check_connection with its six-digit code.",
            binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
          };
        },
      }],
    }), bounded);
    await abortable(session.sendAndWait({
      prompt: "Test this connection: call check_connection without a code, view the image it returns, then call check_connection with the six-digit code you see. Do not guess without viewing it.",
    }, 45_000), bounded);
    if (!verified) throw new AiConnectionError("capability", "The connection did not pass the image and tool-calling check. Choose a vision-capable model with tool support, or retry.");
  } catch (error) {
    if (signal.aborted) throw new AiConnectionError("canceled", "Connection setup canceled.");
    throw providerError(error);
  } finally {
    await client.forceStop();
  }
}

export class AiConnectionService {
  private active = 0;
  private change: { id: string; owner: number; controller: AbortController } | undefined;
  private reset: () => Promise<void> = async () => {};
  private notify: (status: AiConnectionStatus) => void = () => {};

  constructor(
    readonly store: AiProviderStore,
    private readonly runtimeDirectory: () => string,
    private readonly probe = testByomConnection,
  ) {}

  bind(reset: () => Promise<void>, notify: (status: AiConnectionStatus) => void): void {
    this.reset = reset;
    this.notify = notify;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.change) throw new AiConnectionError("busy", "Finish AI connection setup before starting another action.");
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }

  async configuration(): Promise<AiRuntimeConfig> {
    const status = await this.store.status();
    if (!aiConnectionReady(status)) throw new AiConnectionError("setup", AI_SETUP_REQUIRED);
    if (status.mode === "github") return githubRuntimeConfig();
    const profile = status.profile!;
    const key = await this.store.credential(profile);
    if (!key) throw new AiConnectionError("setup", AI_SETUP_REQUIRED);
    const directory = this.runtimeDirectory();
    await mkdir(directory, { recursive: true });
    return byomRuntimeConfig(profile, key, directory);
  }

  cancel(id: string, owner: number): void {
    if (this.change?.id === id && this.change.owner === owner) this.change.controller.abort();
  }

  dispose(): void { this.change?.controller.abort(); }

  private async mutate(
    id: string, owner: number, operation: (signal: AbortSignal) => Promise<AiConnectionStatus>,
  ): Promise<AiConnectionResult> {
    if (this.active || this.change) return { ok: false, code: "busy", error: "Finish or cancel current AI work before changing its connection." };
    const controller = new AbortController();
    this.change = { id, owner, controller };
    try {
      const status = await operation(controller.signal);
      this.notify(status);
      return { ok: true, status };
    } catch (error) {
      const safe = controller.signal.aborted
        ? new AiConnectionError("canceled", "Connection setup canceled.")
        : error instanceof AiConnectionError ? error : providerError(error);
      return { ok: false, code: safe.code, error: safe.message, command: safe.command };
    } finally { this.change = undefined; }
  }

  saveByom(id: string, owner: number, input: unknown, suppliedKey: unknown): Promise<AiConnectionResult> {
    return this.mutate(id, owner, async (signal) => {
      const profile = parseByomConfig(input);
      const key = suppliedKey === undefined || suppliedKey === ""
        ? await this.store.credential(profile) : parseApiKey(suppliedKey);
      if (!key) throw new AiConnectionError("invalid-config", "Enter an API key for this provider and endpoint.");
      const directory = this.runtimeDirectory();
      await mkdir(directory, { recursive: true });
      await this.probe(byomRuntimeConfig(profile, key, directory), signal);
      signal.throwIfAborted();
      await this.reset();
      signal.throwIfAborted();
      return this.store.saveByom(profile, key);
    });
  }

  useGitHub(
    id: string, owner: number, signIn: () => Promise<CopilotSignInResult>,
  ): Promise<AiConnectionResult> {
    return this.mutate(id, owner, async (signal) => {
      const client = new CopilotClient(copilotConnectionOption());
      let authenticated: boolean;
      try {
        await abortable(withStartupTimeout(client.start(), "Copilot CLI"), signal);
        authenticated = (await abortable(client.getAuthStatus(), signal)).isAuthenticated;
      } finally { await client.forceStop(); }
      if (!authenticated) {
        const result = await signIn();
        if (!result.ok) throw new AiConnectionError(
          result.status === "canceled" ? "canceled" : "authentication",
          result.error ?? "GitHub sign-in canceled. Try again.",
          result.command,
        );
      }
      signal.throwIfAborted();
      await this.reset();
      signal.throwIfAborted();
      return this.store.select("github");
    });
  }

  forget(id: string, owner: number): Promise<AiConnectionResult> {
    return this.mutate(id, owner, async () => {
      await this.reset();
      return this.store.forget();
    });
  }
}

export const aiConnection = new AiConnectionService(
  new AiProviderStore(
    () => path.join(app.getPath("userData"), "ai-connection.json"),
    {
      available: () => secureStorageAvailable(process.platform, safeStorage),
      encrypt: (key) => safeStorage.encryptString(key),
      decrypt: (data) => safeStorage.decryptString(data),
    },
  ),
  () => path.join(app.getPath("userData"), "ai-runtime"),
);
