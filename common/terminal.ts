export const SUPPORTED_SHELL_IDS = [
  "zsh",
  "bash",
  "fish",
  "pwsh",
  "windows-powershell",
] as const;

export type SupportedShellId = (typeof SUPPORTED_SHELL_IDS)[number];

export interface TerminalShellDescriptor {
  id: SupportedShellId;
  displayName: string;
  executable: string;
}

export type TerminalLifecycleState =
  | "closed"
  | "starting"
  | "idle"
  | "running"
  | "exited"
  | "error";

export type TerminalIntegrationQuality = "full" | "basic" | "none";

/** Serializable status suitable for sending across Electron's context bridge. */
export interface TerminalStatus {
  state: TerminalLifecycleState;
  shell: TerminalShellDescriptor | null;
  integrationQuality: TerminalIntegrationQuality;
  busy: boolean;
  exitCode: number | null;
  error: string | null;
}

export type TerminalActionResult =
  | { ok: true }
  | { ok: false; error: string };

export const TERMINAL_ARTIFACTS = {
  directory: "terminal",
  transcript: "output.cast",
  commands: "commands.jsonl",
} as const;

export interface TerminalCommandIndex {
  /** Stable for the lifetime of the recorded session. */
  id: string;
  command: string;
  cwd: string;
  shell: SupportedShellId;
  startAtMs: number;
  endAtMs: number;
  durationMs: number;
  exitCode: number | null;
  interrupted: boolean;
  /** UTF-8 byte offsets in the marker-free terminal output stream. */
  transcriptStartByte: number;
  transcriptEndByte: number;
}
