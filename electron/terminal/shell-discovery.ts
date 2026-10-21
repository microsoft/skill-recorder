import { existsSync } from "node:fs";
import path from "node:path";

import type {
  SupportedShellId,
  TerminalShellDescriptor,
} from "../../common/terminal";

export interface ShellDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (candidate: string) => boolean;
}

const SHELL_NAMES: Record<SupportedShellId, string> = {
  zsh: "Z shell",
  bash: "Bash",
  fish: "fish",
  pwsh: "PowerShell",
  "windows-powershell": "Windows PowerShell",
};

function shellIdFromExecutable(executable: string): SupportedShellId | null {
  const name = path.basename(executable).toLowerCase().replace(/\.exe$/, "");
  switch (name) {
    case "zsh":
    case "bash":
    case "fish":
    case "pwsh":
      return name;
    case "powershell":
      return "windows-powershell";
    default:
      return null;
  }
}

function descriptor(
  id: SupportedShellId,
  executable: string,
): TerminalShellDescriptor {
  return { id, displayName: SHELL_NAMES[id], executable };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function pathCandidates(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const pathValue = envValue(env, "PATH") ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const candidates: string[] = [];
  for (const directory of pathValue.split(delimiter)) {
    const cleaned = directory.trim().replace(/^"(.*)"$/, "$1");
    if (!cleaned) continue;
    for (const name of names) candidates.push(join(cleaned, name));
  }
  return candidates;
}

function discoverUnix(
  env: NodeJS.ProcessEnv,
  fileExists: (candidate: string) => boolean,
): TerminalShellDescriptor[] {
  const found = new Map<SupportedShellId, TerminalShellDescriptor>();
  const add = (candidate: string): void => {
    const id = shellIdFromExecutable(candidate);
    if (id !== "zsh" && id !== "bash" && id !== "fish" && id !== "pwsh") return;
    if (!found.has(id) && fileExists(candidate)) found.set(id, descriptor(id, candidate));
  };

  const configured = envValue(env, "SHELL");
  if (configured) add(configured);

  for (const candidate of [
    "/bin/zsh",
    "/usr/bin/zsh",
    "/opt/homebrew/bin/zsh",
    "/usr/local/bin/zsh",
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/fish",
    "/usr/local/bin/fish",
    "/usr/bin/fish",
    "/bin/fish",
    "/opt/homebrew/bin/pwsh",
    "/usr/local/bin/pwsh",
    "/usr/bin/pwsh",
    ...pathCandidates(env, ["zsh", "bash", "fish", "pwsh"], "darwin"),
  ]) {
    add(candidate);
  }

  return [...found.values()];
}

function discoverWindows(
  env: NodeJS.ProcessEnv,
  fileExists: (candidate: string) => boolean,
): TerminalShellDescriptor[] {
  const found = new Map<SupportedShellId, TerminalShellDescriptor>();
  const add = (id: SupportedShellId, candidate: string): void => {
    if (!found.has(id) && fileExists(candidate)) found.set(id, descriptor(id, candidate));
  };

  for (const candidate of pathCandidates(env, ["pwsh.exe"], "win32")) add("pwsh", candidate);
  const programFiles = envValue(env, "ProgramFiles");
  if (programFiles) {
    add(
      "pwsh",
      path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    );
  }

  for (const candidate of pathCandidates(env, ["powershell.exe"], "win32")) {
    add("windows-powershell", candidate);
  }
  const systemRoot = envValue(env, "SystemRoot") ?? envValue(env, "WINDIR");
  if (systemRoot) {
    add(
      "windows-powershell",
      path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    );
  }

  return [...found.values()];
}

/** Discovers known shells using only environment and filesystem lookups. */
export function discoverShells(
  options: ShellDiscoveryOptions = {},
): TerminalShellDescriptor[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  return platform === "win32"
    ? discoverWindows(env, fileExists)
    : discoverUnix(env, fileExists);
}

export function selectDefaultShell(
  shells: readonly TerminalShellDescriptor[],
  options: Pick<ShellDiscoveryOptions, "platform" | "env"> = {},
): TerminalShellDescriptor | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") {
    const configured = envValue(env, "SHELL");
    if (configured) {
      const normalized = path.resolve(configured);
      const match = shells.find((shell) => path.resolve(shell.executable) === normalized);
      if (match) return match;
    }
  }

  const preference: readonly SupportedShellId[] =
    platform === "win32"
      ? ["pwsh", "windows-powershell"]
      : ["zsh", "bash", "fish", "pwsh"];
  for (const id of preference) {
    const match = shells.find((shell) => shell.id === id);
    if (match) return match;
  }
  return null;
}
