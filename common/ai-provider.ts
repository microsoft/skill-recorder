import { z } from "zod";

export const MEMORY_KEY_NOTICE =
  "Secure space is unavailable. The Key will be saved in-memory and will be re-asked next time.";
export const AI_SETUP_REQUIRED =
  "Choose an AI connection before continuing: bring your own model or GitHub authentication.";

export const PROVIDERS = [
  { id: "foundry", name: "Microsoft Foundry / Azure OpenAI (v1)", baseUrl: "", wireApi: "responses" },
  { id: "azure", name: "Azure OpenAI (versioned endpoint)", baseUrl: "", wireApi: "completions" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", wireApi: "responses" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", wireApi: "completions" },
  { id: "custom", name: "Custom OpenAI-compatible", baseUrl: "", wireApi: "completions" },
] as const;

export const ByomConfigSchema = z.object({
  provider: z.enum(["foundry", "azure", "openai", "anthropic", "custom"]),
  baseUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/),
  wireApi: z.enum(["completions", "responses"]),
  apiVersion: z.string().trim().max(80).optional(),
}).superRefine((config, ctx) => {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter a valid HTTPS base URL." });
    return;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Use HTTPS without credentials, query parameters, or a fragment." });
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (config.provider === "foundry" && !pathname.endsWith("/openai/v1")) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Foundry v1 requires a base URL ending in /openai/v1/." });
  }
  if (config.provider === "azure" && pathname !== "") {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Native Azure requires the resource host without an API path." });
  }
  if (/\/(responses|chat\/completions|messages)$/.test(pathname)) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter the base URL, not an individual API operation." });
  }
  if (config.provider === "azure" && !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(config.apiVersion ?? "")) {
    ctx.addIssue({ code: "custom", path: ["apiVersion"], message: "Enter an Azure API version, such as 2024-10-21." });
  }
}).transform((config) => ({
  ...config,
  baseUrl: new URL(config.baseUrl).href.replace(/\/+$/, ""),
  apiVersion: config.provider === "azure" ? config.apiVersion : undefined,
}));

export type ByomConfig = z.infer<typeof ByomConfigSchema>;
export type AiMode = "github" | "byom";
export type KeyStorage = "secure" | "memory";

export interface AiConnectionStatus {
  mode: AiMode | null;
  profile?: ByomConfig;
  hasKey: boolean;
  storage: KeyStorage;
  keyPersistence: KeyStorage | "none";
  warning?: string;
}

export type AiErrorCode = "setup" | "invalid-config" | "busy" | "canceled" | "authentication"
  | "model" | "capability" | "quota" | "connection" | "storage";

export type AiConnectionResult =
  | { ok: true; status: AiConnectionStatus }
  | { ok: false; code: AiErrorCode; error: string; command?: string };

export class AiConnectionError extends Error {
  constructor(readonly code: AiErrorCode, message: string, readonly command?: string) {
    super(message);
    this.name = "AiConnectionError";
  }
}

export function parseByomConfig(value: unknown): ByomConfig {
  const parsed = ByomConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new AiConnectionError("invalid-config", parsed.error.issues[0]?.message ?? "Invalid provider configuration.");
  }
  return parsed.data;
}

export function parseApiKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\r\n\x00]/.test(value)) {
    throw new AiConnectionError("invalid-config", "Enter a valid API key.");
  }
  return value.trim();
}

export function sameCredentialDestination(a: ByomConfig | undefined, b: ByomConfig): boolean {
  return a?.provider === b.provider && a.baseUrl === b.baseUrl;
}

export function aiConnectionReady(status: AiConnectionStatus): boolean {
  return status.mode === "github" || (status.mode === "byom" && status.hasKey && !!status.profile);
}

export function aiDestination(status: AiConnectionStatus | null): string {
  if (status?.mode === "github") return "GitHub Copilot";
  if (status?.mode === "byom" && status.profile) {
    return `${PROVIDERS.find((p) => p.id === status.profile?.provider)?.name ?? "your provider"} (${status.profile.baseUrl})`;
  }
  return "the AI provider you choose";
}
