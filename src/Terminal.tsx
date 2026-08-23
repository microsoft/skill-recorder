import { useEffect, useRef, useState } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type {
  SupportedShellId,
  TerminalShellDescriptor,
  TerminalStatus,
} from "../common/terminal";

export function Terminal() {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Xterm | null>(null);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [shells, setShells] = useState<TerminalShellDescriptor[]>([]);
  const [switching, setSwitching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Xterm({
      cursorBlink: true,
      fontFamily: 'Consolas, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      screenReaderMode: true,
      allowTransparency: false,
      theme: {
        background: "#211f1e",
        foreground: "#f8f5ef",
        cursor: "#f47c68",
        cursorAccent: "#211f1e",
        selectionBackground: "#5c4a46",
        black: "#211f1e",
        red: "#f47c68",
        green: "#63c59b",
        yellow: "#e7b45f",
        blue: "#7eb7d8",
        magenta: "#c89bd0",
        cyan: "#75c7c2",
        white: "#f8f5ef",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const fitAndReport = () => {
      try {
        fit.fit();
        window.skillRecorder.resizeTerminal(terminal.cols, terminal.rows);
      } catch {
        // The window can disappear between ResizeObserver delivery and fit().
      }
    };
    const observer = new ResizeObserver(fitAndReport);
    observer.observe(host);
    const input = terminal.onData((data) => window.skillRecorder.writeTerminal(data));
    const offOutput = window.skillRecorder.onTerminalOutput((data) => terminal.write(data));
    const frame = requestAnimationFrame(() => {
      fitAndReport();
      terminal.focus();
      void window.skillRecorder.terminalReady().then((result) => {
        if (!result.ok) setActionError(result.error);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      offOutput();
      input.dispose();
      observer.disconnect();
      terminalRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    void window.skillRecorder.terminalStatus().then(setStatus);
    void window.skillRecorder.terminalShells().then(setShells);
    return window.skillRecorder.onTerminalStatusChanged(setStatus);
  }, []);

  const switchShell = async (shell: SupportedShellId) => {
    setSwitching(true);
    setActionError(null);
    terminalRef.current?.reset();
    terminalRef.current?.clear();
    const result = await window.skillRecorder.switchTerminalShell(shell);
    if (!result.ok) setActionError(result.error);
    else terminalRef.current?.focus();
    setSwitching(false);
  };

  const stateLabel =
    switching
      ? "Switching shell"
      : status?.state === "running"
      ? "Command running"
      : status?.state === "idle"
        ? "Ready"
        : status?.state === "starting"
          ? "Starting"
          : status?.state === "error"
            ? "Capture error"
            : status?.state === "exited"
              ? "Shell exited"
              : "Recorded terminal";

  return (
    <main className="terminal-page">
      <header className="terminal-toolbar">
        <div className="terminal-recording-state" role="status">
          <span className={`terminal-state-dot ${status?.state ?? "closed"}`} aria-hidden />
          <span>
            <strong>{stateLabel}</strong>
            <small>Output is saved only with this recording</small>
          </span>
        </div>
        <label className="terminal-shell-picker">
          <span>Shell</span>
          <select
            value={status?.shell?.id ?? ""}
            disabled={switching || status?.busy || shells.length === 0}
            onChange={(event) =>
              void switchShell(event.target.value as SupportedShellId)
            }
          >
            {shells.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="terminal-hide"
          onClick={() => void window.skillRecorder.hideTerminal()}
        >
          Hide
        </button>
      </header>
      {(actionError || status?.error) && (
        <div className="terminal-error" role="alert">
          {actionError ?? status?.error}
        </div>
      )}
      <div ref={hostRef} className="terminal-viewport" aria-label="Recorded terminal" />
    </main>
  );
}
