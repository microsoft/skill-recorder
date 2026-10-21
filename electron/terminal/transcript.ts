import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";

import {
  TERMINAL_ARTIFACTS,
  type TerminalCommandIndex,
} from "../../common/terminal";
import type {
  CommandFinishEvent,
  CommandStartEvent,
} from "./protocol";

export interface FinalizedTerminalCommand {
  index: TerminalCommandIndex;
}

export interface TerminalTranscriptWriterOptions {
  sessionDir: string;
  sessionStartedAt: number;
  columns?: number;
  rows?: number;
  onCommand?: (command: FinalizedTerminalCommand) => void;
  onError?: (error: Error) => void;
  onDrain?: () => void;
}

interface ActiveCommand {
  event: CommandStartEvent;
  transcriptStartByte: number;
}

function streamClosed(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.once("close", resolve));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Streams the marker-free PTY output and its command index to session artifacts.
 * The transcript is asciicast v2 so it remains replayable and grep-able without
 * introducing a second, unbounded copy of terminal output.
 */
export class TerminalTranscriptWriter {
  readonly directory: string;
  readonly transcriptPath: string;
  readonly commandsPath: string;

  private readonly transcript: WriteStream;
  private readonly commands: WriteStream;
  private readonly transcriptClosed: Promise<void>;
  private readonly commandsClosed: Promise<void>;
  private readonly sessionStartedAt: number;
  private readonly onCommand?: (command: FinalizedTerminalCommand) => void;
  private readonly onError?: (error: Error) => void;
  private transcriptBytes = 0;
  private active: ActiveCommand | null = null;
  private error: Error | null = null;
  private ended = false;

  constructor(options: TerminalTranscriptWriterOptions) {
    this.sessionStartedAt = options.sessionStartedAt;
    this.onCommand = options.onCommand;
    this.onError = options.onError;
    this.directory = path.join(options.sessionDir, TERMINAL_ARTIFACTS.directory);
    this.transcriptPath = path.join(this.directory, TERMINAL_ARTIFACTS.transcript);
    this.commandsPath = path.join(this.directory, TERMINAL_ARTIFACTS.commands);
    mkdirSync(this.directory, { recursive: true });

    this.transcript = createWriteStream(this.transcriptPath, { flags: "a" });
    this.commands = createWriteStream(this.commandsPath, { flags: "a" });
    this.transcriptClosed = streamClosed(this.transcript);
    this.commandsClosed = streamClosed(this.commands);
    const handleError = (value: unknown): void => {
      if (this.error) return;
      this.error = asError(value);
      this.onError?.(this.error);
    };
    this.transcript.on("error", handleError);
    this.commands.on("error", handleError);
    if (options.onDrain) this.transcript.on("drain", options.onDrain);

    const header = {
      version: 2,
      width: options.columns ?? 100,
      height: options.rows ?? 30,
      timestamp: Math.floor(options.sessionStartedAt / 1000),
      env: { TERM: "xterm-256color", SHELL: "skill-recorder" },
    };
    this.writeTranscriptLine(JSON.stringify(header));
  }

  get writeError(): Error | null {
    return this.error;
  }

  get byteOffset(): number {
    return this.transcriptBytes;
  }

  appendOutput(data: string, epoch = Date.now()): boolean {
    if (this.ended || !data) return true;
    const atSeconds = Math.max(0, epoch - this.sessionStartedAt) / 1000;
    return this.writeTranscriptLine(JSON.stringify([atSeconds, "o", data]));
  }

  resize(columns: number, rows: number, epoch = Date.now()): boolean {
    if (this.ended) return true;
    const atSeconds = Math.max(0, epoch - this.sessionStartedAt) / 1000;
    return this.writeTranscriptLine(
      JSON.stringify([atSeconds, "r", `${columns}x${rows}`]),
    );
  }

  startCommand(event: CommandStartEvent): void {
    if (this.ended) return;
    if (this.active) this.finalizeActive(null, event.atMs, true);
    this.active = {
      event,
      transcriptStartByte: this.transcriptBytes,
    };
  }

  finishCommand(event: CommandFinishEvent): TerminalCommandIndex | null {
    if (!this.active || this.active.event.id !== event.id) return null;
    return this.finalizeActive(event.exitCode, event.atMs, false);
  }

  interruptActive(epoch = Date.now()): TerminalCommandIndex | null {
    return this.active ? this.finalizeActive(null, epoch, true) : null;
  }

  async close(epoch = Date.now()): Promise<void> {
    if (this.ended) {
      await Promise.all([this.transcriptClosed, this.commandsClosed]);
      if (this.error) throw this.error;
      return;
    }
    this.ended = true;
    if (this.active) this.finalizeActive(null, epoch, true);
    this.transcript.end();
    this.commands.end();
    await Promise.all([this.transcriptClosed, this.commandsClosed]);
    if (this.error) throw this.error;
  }

  destroy(): void {
    this.ended = true;
    this.transcript.destroy();
    this.commands.destroy();
  }

  private relative(epoch: number): number {
    return Math.max(0, Math.round(epoch - this.sessionStartedAt));
  }

  private finalizeActive(
    exitCode: number | null,
    endEpoch: number,
    interrupted: boolean,
  ): TerminalCommandIndex {
    const active = this.active;
    if (!active) throw new Error("No active terminal command to finalize");
    this.active = null;
    const startAtMs = this.relative(active.event.atMs);
    const endAtMs = Math.max(startAtMs, this.relative(endEpoch));
    const index: TerminalCommandIndex = {
      id: active.event.id,
      command: active.event.command,
      cwd: active.event.cwd,
      shell: active.event.shell,
      startAtMs,
      endAtMs,
      durationMs: endAtMs - startAtMs,
      exitCode,
      interrupted,
      transcriptStartByte: active.transcriptStartByte,
      transcriptEndByte: this.transcriptBytes,
    };
    this.commands.write(`${JSON.stringify(index)}\n`);
    this.onCommand?.({ index });
    return index;
  }

  private writeTranscriptLine(line: string): boolean {
    const output = `${line}\n`;
    this.transcriptBytes += Buffer.byteLength(output);
    return this.transcript.write(output);
  }
}
