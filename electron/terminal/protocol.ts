import type { SupportedShellId } from "../../common/terminal";

export const RECORDER_OSC_PREFIX = "\u001b]6973;skill-recorder;1;";
export const RECORDER_OSC_BEL = "\u0007";
const RECORDER_OSC_ST = "\u001b\\";
const MAX_MARKER_LENGTH = 64 * 1024;

export interface PromptReadyEvent {
  type: "prompt-ready";
}

export interface CommandStartEvent {
  type: "command-start";
  id: string;
  command: string;
  cwd: string;
  shell: SupportedShellId;
  atMs: number;
}

export interface CommandFinishEvent {
  type: "command-finish";
  id: string;
  exitCode: number | null;
  atMs: number;
}

export type TerminalProtocolEvent =
  | PromptReadyEvent
  | CommandStartEvent
  | CommandFinishEvent;

export type TerminalProtocolItem =
  | { type: "output"; data: string }
  | { type: "event"; event: TerminalProtocolEvent };

function encodeField(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function encodeRecorderMarker(
  nonce: string,
  event: TerminalProtocolEvent,
): string {
  let body: string;
  switch (event.type) {
    case "prompt-ready":
      body = "ready";
      break;
    case "command-start":
      body = [
        "start",
        event.id,
        event.command,
        event.cwd,
        event.shell,
        event.atMs,
      ]
        .map(encodeField)
        .join(";");
      break;
    case "command-finish":
      body = [
        "finish",
        event.id,
        event.exitCode === null ? "" : event.exitCode,
        event.atMs,
      ]
        .map(encodeField)
        .join(";");
      break;
  }
  return `${RECORDER_OSC_PREFIX}${nonce};${body}${RECORDER_OSC_BEL}`;
}

function decodeField(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseFiniteTimestamp(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseMarkerBody(body: string, nonce: string): TerminalProtocolEvent | null {
  const fields = body.split(";");
  if (fields[0] !== nonce) return null;
  const kind = fields[1];

  if (kind === "ready" && fields.length === 2) {
    return { type: "prompt-ready" };
  }

  if (kind === "start" && fields.length === 7) {
    const decoded = fields.slice(2).map(decodeField);
    if (decoded.some((field) => field === null)) return null;
    const [id, command, cwd, shellValue, atValue] = decoded as string[];
    if (
      id.length === 0 ||
      !["zsh", "bash", "fish", "pwsh", "windows-powershell"].includes(shellValue)
    ) {
      return null;
    }
    const atMs = parseFiniteTimestamp(atValue);
    if (atMs === null) return null;
    return {
      type: "command-start",
      id,
      command,
      cwd,
      shell: shellValue as SupportedShellId,
      atMs,
    };
  }

  if (kind === "finish" && fields.length === 5) {
    const id = decodeField(fields[2]);
    const exitValue = decodeField(fields[3]);
    const atValue = decodeField(fields[4]);
    if (id === null || id.length === 0 || exitValue === null || atValue === null) {
      return null;
    }
    const atMs = parseFiniteTimestamp(atValue);
    if (atMs === null || (exitValue !== "" && !/^-?\d+$/.test(exitValue))) return null;
    const exitCode = exitValue === "" ? null : Number(exitValue);
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) return null;
    return { type: "command-finish", id, exitCode, atMs };
  }

  return null;
}

function terminatorAt(value: string, from: number): { index: number; length: number } | null {
  const bel = value.indexOf(RECORDER_OSC_BEL, from);
  const st = value.indexOf(RECORDER_OSC_ST, from);
  if (bel < 0 && st < 0) return null;
  if (bel >= 0 && (st < 0 || bel < st)) return { index: bel, length: 1 };
  return { index: st, length: 2 };
}

function partialPrefixLength(value: string): number {
  const max = Math.min(value.length, RECORDER_OSC_PREFIX.length - 1);
  for (let length = max; length > 0; length--) {
    if (RECORDER_OSC_PREFIX.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

/**
 * Incrementally removes only authenticated, structurally valid recorder markers.
 * Foreign or malformed OSC sequences are returned byte-for-byte as terminal output.
 */
export class TerminalProtocolParser {
  private pending = "";

  constructor(private readonly nonce: string) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      throw new Error("Terminal protocol nonce must be 16-128 URL-safe characters");
    }
  }

  push(chunk: string): TerminalProtocolItem[] {
    let input = this.pending + chunk;
    this.pending = "";
    const items: TerminalProtocolItem[] = [];
    const emitOutput = (data: string): void => {
      if (!data) return;
      const previous = items.at(-1);
      if (previous?.type === "output") previous.data += data;
      else items.push({ type: "output", data });
    };

    while (input.length > 0) {
      const markerStart = input.indexOf(RECORDER_OSC_PREFIX);
      if (markerStart < 0) {
        const held = partialPrefixLength(input);
        emitOutput(input.slice(0, input.length - held));
        this.pending = input.slice(input.length - held);
        break;
      }

      emitOutput(input.slice(0, markerStart));
      const terminator = terminatorAt(input, markerStart + RECORDER_OSC_PREFIX.length);
      if (!terminator) {
        if (input.length - markerStart <= MAX_MARKER_LENGTH) {
          this.pending = input.slice(markerStart);
          break;
        }
        emitOutput(input.slice(markerStart, markerStart + RECORDER_OSC_PREFIX.length));
        input = input.slice(markerStart + RECORDER_OSC_PREFIX.length);
        continue;
      }

      const markerEnd = terminator.index + terminator.length;
      const marker = input.slice(markerStart, markerEnd);
      const body = input.slice(
        markerStart + RECORDER_OSC_PREFIX.length,
        terminator.index,
      );
      const event = parseMarkerBody(body, this.nonce);
      if (event) items.push({ type: "event", event });
      else emitOutput(marker);
      input = input.slice(markerEnd);
    }

    return items;
  }

  flush(): TerminalProtocolItem[] {
    if (!this.pending) return [];
    const output = this.pending;
    this.pending = "";
    return [{ type: "output", data: output }];
  }
}
