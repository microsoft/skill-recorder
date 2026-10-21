import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { win32 } from "node:path";

// Microsoft's public microsoft.com OpenID metadata, verified 2026-09-15:
// https://login.microsoftonline.com/microsoft.com/v2.0/.well-known/openid-configuration
// This is a routing hint only, never proof of identity, employment, or authorization.
const MICROSOFT_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const MAX_OUTPUT_BYTES = 128 * 1024;
const TIMEOUT_MS = 3_000;

/**
 * Parse only dsregcmd's documented device/user state and associated tenant sections.
 * https://learn.microsoft.com/en-us/entra/identity/devices/troubleshoot-device-dsregcmd
 * Unknown/localized output deliberately produces no hint.
 */
export function parseMicrosoftSignInHint(output: string): boolean {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return false;

  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  for (const line of output.split(/\r?\n/)) {
    const heading = /^\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (heading) {
      const name = heading[1].trim();
      section = undefined;
      if (!/^(Device State|User State|Tenant Details|Work Account \d+)$/.test(name)) continue;
      if (sections.has(name)) return false;
      section = new Map();
      sections.set(name, section);
      continue;
    }
    if (!section) continue;
    const field = /^\s*(AzureAdJoined|WorkplaceJoined|TenantId|WorkplaceTenantId)\s*:\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    if (section.has(field[1])) return false;
    section.set(field[1], field[2]);
  }

  const isMicrosoft = (tenant: string | undefined) =>
    tenant?.toLowerCase() === MICROSOFT_TENANT_ID;
  if (
    sections.get("Device State")?.get("AzureAdJoined") === "YES" &&
    isMicrosoft(sections.get("Tenant Details")?.get("TenantId"))
  ) return true;

  return sections.get("User State")?.get("WorkplaceJoined") === "YES" &&
    [...sections].some(([name, fields]) =>
      /^Work Account \d+$/.test(name) && isMicrosoft(fields.get("WorkplaceTenantId")),
    );
}

export interface MicrosoftSignInHintDependencies {
  platform: string;
  systemRoot: string | undefined;
  execFile: (
    file: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  log: { info(message: string, details: { reason: string }): void };
}

/** Injectable probe for tests; it never reads credentials or searches account stores. */
export function createMicrosoftSignInHintProbe(deps: MicrosoftSignInHintDependencies) {
  return async (): Promise<boolean> => {
    const noHint = (reason: string): false => {
      deps.log.info("Microsoft sign-in hint unavailable", { reason });
      return false;
    };
    if (deps.platform !== "win32") return noHint("unsupported-platform");

    // Never fall back to PATH, the current directory, or a relative/UNC root.
    const root = deps.systemRoot;
    if (!root || !/^[a-z]:\\/i.test(root) || /[\x00-\x1f]/.test(root) ||
      root.split(/[\\/]/).some((part) => part === "..")) {
      return noHint("unsupported-system-path");
    }

    try {
      const output = await new Promise<string>((resolve, reject) => {
        deps.execFile(win32.join(root, "System32", "dsregcmd.exe"), ["/status"], {
          encoding: "utf8",
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
        }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      return parseMicrosoftSignInHint(output) || noHint("no-matching-hint");
    } catch (error) {
      // Whitelist categories only: messages/stdout/stderr can contain account/device data.
      const failure = error as { code?: unknown; killed?: unknown } | null;
      const reason = failure?.code === "ENOENT" ? "executable-missing"
        : failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-limit"
        : failure?.code === "ETIMEDOUT" || failure?.killed === true ? "timeout"
        : "probe-failed";
      return noHint(reason);
    }
  };
}
