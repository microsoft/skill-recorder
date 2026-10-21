import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { spawn, type IPty } from "node-pty";

import {
  type SupportedShellId,
  type TerminalActionResult,
  type TerminalShellDescriptor,
  type TerminalStatus,
} from "../../common/terminal";
import type { TerminalCommandPayload } from "../../common/events";
import {
  TerminalProtocolParser,
  type TerminalProtocolEvent,
} from "./protocol";
import {
  discoverShells,
  selectDefaultShell,
  type ShellDiscoveryOptions,
} from "./shell-discovery";
import {
  prepareShellIntegration,
  type IntegratedShellLaunch,
} from "./shell-integration";
import { TerminalTranscriptWriter } from "./transcript";

export interface TerminalSessionOptions {
  sessionDir: string;
  sessionStartedAt: number;
  publishCommand: (payload: TerminalCommandPayload) => void;
  shellDiscovery?: ShellDiscoveryOptions;
  initialCwd?: string;
  closeGraceMs?: number;
  spawnPty?: typeof spawn;
}

type StatusListener = (status: TerminalStatus) => void;
type OutputListener = (data: string) => void;
const execFileAsync = promisify(execFile);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonce(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Owns the one PTY associated with a recording. It has no global hooks and does
 * no work until start() is called from the recording bar's Open terminal action.
 */
export class TerminalSession {
  readonly shells: readonly TerminalShellDescriptor[];

  private readonly options: TerminalSessionOptions;
  private readonly statusListeners = new Set<StatusListener>();
  private readonly outputListeners = new Set<OutputListener>();
  private readonly writer: TerminalTranscriptWriter;
  private process: IPty | null = null;
  private launch: IntegratedShellLaunch | null = null;
  private parser: TerminalProtocolParser | null = null;
  private currentStatus: TerminalStatus;
  private selected: TerminalShellDescriptor | null;
  private closing: Promise<void> | null = null;
  private starting: Promise<TerminalActionResult> | null = null;
  private finishing: Promise<void> | null = null;
  private finalizing = false;
  private destroyed = false;
  private readonly ownedProcessIds = new Set<number>();
  private transcriptPaused = false;
  private activeCommand: string | null = null;

  constructor(options: TerminalSessionOptions) {
    this.options = options;
    this.shells = discoverShells(options.shellDiscovery);
    this.selected = selectDefaultShell(this.shells, options.shellDiscovery);
    this.currentStatus = {
      state: "closed",
      shell: this.selected,
      integrationQuality: "none",
      busy: false,
      exitCode: null,
      error: this.selected ? null : "No supported terminal shell was found.",
    };
    this.writer = new TerminalTranscriptWriter({
      sessionDir: options.sessionDir,
      sessionStartedAt: options.sessionStartedAt,
      onCommand: ({ index }) => {
        options.publishCommand({
          commandId: index.id,
          command: index.command,
          cwd: index.cwd,
          shell: index.shell,
          exitCode: index.exitCode ?? undefined,
          durationMs: index.durationMs,
          interrupted: index.interrupted || undefined,
          transcriptStartByte: index.transcriptStartByte,
          transcriptEndByte: index.transcriptEndByte,
        });
      },
      onError: (error) => this.fail(`Terminal transcript capture failed: ${error.message}`),
      onDrain: () => {
        if (!this.transcriptPaused || !this.process) return;
        this.transcriptPaused = false;
        this.process.resume();
      },
    });
  }

  status(): TerminalStatus {
    return {
      ...this.currentStatus,
      shell: this.currentStatus.shell ? { ...this.currentStatus.shell } : null,
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status());
    return () => this.statusListeners.delete(listener);
  }

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  async start(shellId?: SupportedShellId): Promise<TerminalActionResult> {
    if (this.finalizing || this.destroyed) {
      return { ok: false, error: "The recorded terminal is closing." };
    }
    if (this.process) return { ok: true };
    if (this.starting) return this.starting;
    this.starting = this.startInternal(shellId).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startInternal(
    shellId?: SupportedShellId,
  ): Promise<TerminalActionResult> {
    if (this.closing) await this.closing;
    const selected = shellId
      ? this.shells.find((candidate) => candidate.id === shellId) ?? null
      : this.selected;
    if (!selected) return { ok: false, error: "The selected shell is unavailable." };
    this.selected = selected;
    this.setStatus({
      state: "starting",
      shell: selected,
      integrationQuality: "none",
      busy: true,
      exitCode: null,
      error: null,
    });

    const markerNonce = nonce();
    try {
      const launch = await prepareShellIntegration(selected, {
        nonce: markerNonce,
        env: process.env,
      });
      if (this.finalizing || this.destroyed) {
        await launch.cleanup();
        return { ok: false, error: "The recorded terminal is closing." };
      }
      const pty = (this.options.spawnPty ?? spawn)(
        launch.executable,
        launch.args,
        {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd: this.options.initialCwd ?? homedir(),
          env: {
            ...launch.env,
            TERM: "xterm-256color",
            TERM_PROGRAM: "skill-recorder",
            SKILL_RECORDER_TERMINAL: "1",
          },
        },
      );
      this.launch = launch;
      this.ownedProcessIds.clear();
      this.parser = new TerminalProtocolParser(markerNonce);
      this.process = pty;
      this.setStatus({
        state: "starting",
        shell: selected,
        integrationQuality: launch.integrationQuality,
        busy: true,
        exitCode: null,
        error: null,
      });
      pty.onData((data) => this.handleData(data));
      pty.onExit(({ exitCode }) => void this.handleExit(exitCode));
      return { ok: true };
    } catch (error) {
      await this.cleanupLaunch();
      this.process = null;
      this.parser = null;
      this.fail(`Could not start the recorded terminal: ${message(error)}`);
      return { ok: false, error: this.currentStatus.error ?? "Could not start terminal." };
    }
  }

  write(data: string): TerminalActionResult {
    if (!this.process) return { ok: false, error: "The terminal is not running." };
    this.process.write(data);
    return { ok: true };
  }

  resize(columns: number, rows: number): TerminalActionResult {
    if (
      !this.process ||
      !Number.isInteger(columns) ||
      !Number.isInteger(rows) ||
      columns < 2 ||
      rows < 1 ||
      columns > 1000 ||
      rows > 500
    ) {
      return { ok: false, error: "Invalid terminal size." };
    }
    this.process.resize(columns, rows);
    this.writer.resize(columns, rows);
    return { ok: true };
  }

  isBusy(): boolean {
    return this.currentStatus.busy;
  }

  busyDetails(): { busy: boolean; command: string | null } {
    return { busy: this.currentStatus.busy, command: this.activeCommand };
  }

  async switchShell(shellId: SupportedShellId): Promise<TerminalActionResult> {
    if (this.finalizing || this.destroyed) {
      return { ok: false, error: "The recorded terminal is closing." };
    }
    const shell = this.shells.find((candidate) => candidate.id === shellId);
    if (!shell) return { ok: false, error: "The selected shell is unavailable." };
    if (this.currentStatus.busy && this.process) {
      return { ok: false, error: "Finish the running command before switching shells." };
    }
    await this.closeProcess(250);
    return this.start(shellId);
  }

  finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finalizing = true;
    this.finishing = this.finishInternal();
    return this.finishing;
  }

  private async finishInternal(): Promise<void> {
    if (this.starting) await this.starting;
    await this.closeProcess();
    try {
      await this.writer.close();
      this.setStatus({
        state: "closed",
        shell: this.selected,
        integrationQuality: this.currentStatus.integrationQuality,
        busy: false,
        exitCode: this.currentStatus.exitCode,
        error: this.currentStatus.error,
      });
    } catch (error) {
      this.fail(`Could not finalize the terminal transcript: ${message(error)}`);
      throw error;
    }
  }

  destroy(): void {
    this.finalizing = true;
    this.destroyed = true;
    if (this.process) this.killProcessTreeSync(this.process, true);
    this.process = null;
    this.writer.destroy();
    void this.cleanupLaunch();
  }

  private handleData(data: string): void {
    const parser = this.parser;
    if (!parser) return;
    for (const item of parser.push(data)) {
      if (item.type === "event") this.handleEvent(item.event);
      else this.emitOutput(item.data);
    }
  }

  private handleEvent(event: TerminalProtocolEvent): void {
    switch (event.type) {
      case "prompt-ready":
        this.activeCommand = null;
        this.setStatus({
          ...this.currentStatus,
          state: "idle",
          busy: false,
          error: this.writer.writeError?.message ?? null,
        });
        break;
      case "command-start":
        this.activeCommand = event.command;
        this.writer.startCommand({ ...event, atMs: Date.now() });
        this.setStatus({
          ...this.currentStatus,
          state: "running",
          busy: true,
          error: this.writer.writeError?.message ?? null,
        });
        break;
      case "command-finish":
        this.writer.finishCommand({ ...event, atMs: Date.now() });
        this.activeCommand = null;
        break;
    }
  }

  private emitOutput(data: string): void {
    if (!data) return;
    const writable = this.writer.appendOutput(data);
    if (!writable && this.process && !this.transcriptPaused) {
      this.transcriptPaused = true;
      this.process.pause();
    }
    for (const listener of this.outputListeners) listener(data);
  }

  private async handleExit(exitCode: number): Promise<void> {
    const process = this.process;
    if (!process) return;
    this.process = null;
    const parser = this.parser;
    this.parser = null;
    for (const item of parser?.flush() ?? []) {
      if (item.type === "output") this.emitOutput(item.data);
    }
    this.writer.interruptActive();
    this.activeCommand = null;
    await this.cleanupLaunch();
    this.setStatus({
      state: "exited",
      shell: this.selected,
      integrationQuality: this.currentStatus.integrationQuality,
      busy: false,
      exitCode,
      error: this.writer.writeError?.message ?? null,
    });
  }

  private closeProcess(closeGraceMs = this.options.closeGraceMs ?? 750): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeProcessInternal(closeGraceMs).finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private async closeProcessInternal(closeGraceMs: number): Promise<void> {
    const pty = this.process;
    if (!pty) {
      await this.cleanupLaunch();
      return;
    }
    const exited = new Promise<void>((resolve) => {
      const disposable = pty.onExit(() => {
        disposable.dispose();
        resolve();
      });
    });
    if (!this.currentStatus.busy) await this.killProcessTree(pty, false);
    const grace = new Promise<void>((resolve) =>
      setTimeout(resolve, closeGraceMs),
    );
    await Promise.race([exited, grace]);
    if (this.process === pty) {
      await this.killProcessTree(pty, false);
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
    if (this.ownedProcessIds.size > 0 || this.process === pty) {
      await this.killProcessTree(pty, true);
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (this.process === pty) {
        throw new Error("The recorded terminal process did not exit after forced shutdown.");
      }
    }
    this.ownedProcessIds.clear();
    await this.cleanupLaunch();
  }

  private async killProcessTree(pty: IPty, force: boolean): Promise<void> {
    const signal = force ? "SIGKILL" : "SIGHUP";
    if (process.platform === "win32") {
      try {
        await execFileAsync(
          "taskkill.exe",
          ["/PID", String(pty.pid), "/T", ...(force ? ["/F"] : [])],
          {
            timeout: 2_000,
            windowsHide: true,
          },
        );
      } catch {
        // The process tree may already have exited before taskkill inspected it.
      }
    } else {
      for (const pid of await this.unixProcessTree(pty.pid)) {
        this.ownedProcessIds.add(pid);
      }
      for (const pid of this.ownedProcessIds) {
        try {
          process.kill(pid, signal);
        } catch {
          // Descendants can exit while the process snapshot is being signalled.
        }
      }
    }
    try {
      pty.kill(signal);
    } catch {
      // The PTY may exit between the identity check and kill().
    }
  }

  private killProcessTreeSync(pty: IPty, force: boolean): void {
    const signal = force ? "SIGKILL" : "SIGHUP";
    try {
      if (process.platform !== "win32") process.kill(-pty.pid, signal);
    } catch {
      // Best-effort fallback used only after asynchronous teardown failed.
    }
    try {
      pty.kill(signal);
    } catch {
      // The PTY may already have exited.
    }
  }

  private async unixProcessTree(rootPid: number): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync(
        "ps",
        ["-axo", "pid=,ppid=,sess="],
        { timeout: 2_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const rows = stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(
          (row): row is [number, number, number] =>
            row.length === 3 && row.every(Number.isInteger),
        );
      const selected = new Set<number>([rootPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parentPid, sessionId] of rows) {
          if (
            pid !== process.pid &&
            !selected.has(pid) &&
            (sessionId === rootPid || selected.has(parentPid))
          ) {
            selected.add(pid);
            changed = true;
          }
        }
      }
      const depth = (pid: number): number => {
        let current = pid;
        let value = 0;
        const visited = new Set<number>();
        while (current !== rootPid && !visited.has(current)) {
          visited.add(current);
          const parent = rows.find(([candidate]) => candidate === current)?.[1];
          if (parent == null) break;
          current = parent;
          value += 1;
        }
        return value;
      };
      return [...selected].sort((left, right) => depth(right) - depth(left));
    } catch {
      return [rootPid];
    }
  }

  private async cleanupLaunch(): Promise<void> {
    const launch = this.launch;
    this.launch = null;
    if (launch) await launch.cleanup();
  }

  private fail(error: string): void {
    this.setStatus({
      ...this.currentStatus,
      state: "error",
      busy: Boolean(this.process),
      error,
    });
  }

  private setStatus(status: TerminalStatus): void {
    this.currentStatus = status;
    const snapshot = this.status();
    for (const listener of this.statusListeners) listener(snapshot);
  }
}
