import { useCallback, useEffect, useRef, useState } from "react";

import type {
  MicrophoneSettingsStatus,
  RecorderStatus,
} from "../common/ipc";
import type { TerminalStatus } from "../common/terminal";
import {
  DEFAULT_NARRATION_LANGUAGE,
  narrationLanguageLabel,
} from "../common/narration";
import { formatMs } from "./format";
import { useT } from "./i18n";

export function RecordingControls() {
  const t = useT();
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [microphoneSettings, setMicrophoneSettings] =
    useState<MicrophoneSettingsStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showMicrophoneMenu, setShowMicrophoneMenu] = useState(false);
  const [microphonePending, setMicrophonePending] = useState(false);
  const [devicePending, setDevicePending] = useState(false);
  const [finishPending, setFinishPending] = useState<"done" | "discard" | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus | null>(null);
  const [terminalPending, setTerminalPending] = useState(false);
  const [terminalConfirm, setTerminalConfirm] = useState<"done" | "discard" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const keepRecordingRef = useRef<HTMLButtonElement>(null);
  const microphoneControlRef = useRef<HTMLDivElement>(null);
  const microphoneMenuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void window.skillRecorder.status().then(setStatus);
    void window.skillRecorder.microphoneSettings().then(setMicrophoneSettings);
    void window.skillRecorder.terminalStatus().then(setTerminalStatus);
    const offStatus = window.skillRecorder.onStatusChanged(setStatus);
    const offMicrophones =
      window.skillRecorder.onMicrophoneSettingsChanged(setMicrophoneSettings);
    const offTerminal =
      window.skillRecorder.onTerminalStatusChanged(setTerminalStatus);
    const offTerminalFinish =
      window.skillRecorder.onTerminalFinishConfirmationRequested(() => {
        setConfirmDiscard(false);
        setShowMicrophoneMenu(false);
        setTerminalConfirm("done");
      });
    return () => {
      offStatus();
      offMicrophones();
      offTerminal();
      offTerminalFinish();
    };
  }, []);

  const recording = status?.state === "recording";
  const startedAt = status?.startedAt ?? null;
  useEffect(() => {
    if (!recording || startedAt == null) {
      setElapsed(0);
      return;
    }
    const update = () => setElapsed(Math.max(0, Date.now() - startedAt));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [recording, startedAt]);

  useEffect(() => {
    if (recording) return;
    if (confirmDiscard) setConfirmDiscard(false);
    if (showMicrophoneMenu) setShowMicrophoneMenu(false);
    setMicrophonePending(false);
    setDevicePending(false);
    setFinishPending(null);
    setTerminalConfirm(null);
    setTerminalPending(false);
  }, [confirmDiscard, recording, showMicrophoneMenu]);

  useEffect(() => {
    void window.skillRecorder.setRecordingControlsExpanded(
      confirmDiscard || showMicrophoneMenu || terminalConfirm !== null,
    );
  }, [confirmDiscard, showMicrophoneMenu, terminalConfirm]);

  useEffect(() => {
    if (!confirmDiscard) return;
    keepRecordingRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmDiscard(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmDiscard]);

  useEffect(() => {
    if (!showMicrophoneMenu) return;
    microphoneMenuRef.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMicrophoneMenu(false);
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        microphoneMenuRef.current?.contains(target) ||
        microphoneControlRef.current?.contains(target)
      ) {
        return;
      }
      setShowMicrophoneMenu(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [showMicrophoneMenu]);

  useEffect(() => {
    if (
      recording &&
      (status?.microphone.state === "error" ||
        microphoneSettings?.preferredDeviceUnavailable)
    ) {
      setConfirmDiscard(false);
      setShowMicrophoneMenu(true);
    }
  }, [
    microphoneSettings?.preferredDeviceUnavailable,
    recording,
    status?.microphone.state,
  ]);

  const toggleMicrophone = useCallback(async () => {
    if (!status) return;
    setMicrophonePending(true);
    setActionError(null);
    const enable = status.microphone.state !== "on";
    const result = await window.skillRecorder.setMicrophoneEnabled(enable);
    if (!result.ok) setActionError(result.error ?? t("controls.error.microphoneChange"));
    setMicrophonePending(false);
  }, [status, t]);

  const selectMicrophone = useCallback(async (deviceId: string) => {
    setDevicePending(true);
    setActionError(null);
    const result = await window.skillRecorder.selectMicrophone(deviceId);
    setMicrophoneSettings(result.status);
    if (!result.ok) {
      setActionError(result.error ?? t("controls.error.microphoneSwitch"));
    } else {
      setShowMicrophoneMenu(false);
    }
    setDevicePending(false);
  }, [t]);

  const done = useCallback(async (forceTerminal = false) => {
    setFinishPending("done");
    setActionError(null);
    const result = await window.skillRecorder.stop(forceTerminal);
    if (result.requiresTerminalConfirmation) {
      setTerminalConfirm("done");
      setFinishPending(null);
      return;
    }
    if (!result.ok) {
      setActionError(result.error ?? t("controls.error.stop"));
      setFinishPending(null);
    }
  }, [t]);

  const discard = useCallback(async (forceTerminal = false) => {
    setFinishPending("discard");
    setActionError(null);
    const result = await window.skillRecorder.discard(forceTerminal);
    if (result.requiresTerminalConfirmation) {
      setConfirmDiscard(false);
      setTerminalConfirm("discard");
      setFinishPending(null);
      return;
    }
    if (!result.ok) {
      const error = result.error ?? t("controls.error.discard");
      setActionError(error);
      setFinishPending(null);
      window.alert(error);
    }
  }, [t]);

  const openTerminal = useCallback(async () => {
    setTerminalPending(true);
    setActionError(null);
    setConfirmDiscard(false);
    setShowMicrophoneMenu(false);
    const result = await window.skillRecorder.openTerminal();
    if (!result.ok) setActionError(result.error);
    setTerminalPending(false);
  }, []);

  const transitionBusy = status?.transition !== "none";
  const microphoneBusy =
    microphonePending ||
    devicePending ||
    status?.microphone.state === "starting" ||
    status?.microphone.state === "stopping";
  const lifecycleBusy = finishPending !== null || transitionBusy || !recording;
  const microphoneOn = status?.microphone.state === "on";
  const microphoneError = status?.microphone.state === "error";
  const narrationLanguage = narrationLanguageLabel(
    status?.narrationLanguage ?? DEFAULT_NARRATION_LANGUAGE,
  );
  const systemDefaultLabel = t("controls.microphone.systemDefault");
  const activeMicrophoneLabel =
    status?.microphone.activeDevice?.label ??
    microphoneSettings?.selectedDeviceLabel ??
    systemDefaultLabel;
  const microphoneLabel =
    status?.microphone.state === "starting"
      ? t("controls.microphone.starting")
      : status?.microphone.state === "stopping"
        ? t("controls.microphone.stopping")
        : microphoneOn
          ? t("controls.microphone.on")
          : microphoneError
            ? t("controls.microphone.retry")
            : t("controls.microphone.off");
  const error =
    actionError ??
    status?.microphone.error ??
    microphoneSettings?.error ??
    microphoneSettings?.fallback ??
    null;
  const captureLabel =
    status?.transition === "starting"
      ? t("controls.capture.starting")
      : status?.transition === "stopping"
        ? t("controls.capture.saving")
        : status?.transition === "discarding"
          ? t("controls.capture.discarding")
          : t("controls.capture.capturing");

  return (
    <div
      className={`recording-controls ${
        confirmDiscard || showMicrophoneMenu || terminalConfirm ? "expanded" : ""
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && confirmDiscard) setConfirmDiscard(false);
      }}
    >
      {confirmDiscard && (
        <section
          className="recording-discard-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="recording-discard-title"
          aria-describedby="recording-discard-description"
        >
          <div>
            <h2 id="recording-discard-title">{t("controls.discard.title")}</h2>
            <p id="recording-discard-description">
              {t("controls.discard.description")}
            </p>
          </div>
          <div className="recording-discard-actions">
            <button
              ref={keepRecordingRef}
              className="recording-keep"
              disabled={finishPending === "discard"}
              onClick={() => setConfirmDiscard(false)}
            >
              {t("controls.discard.keep")}
            </button>
            <button
              className="recording-confirm-discard"
              disabled={finishPending === "discard"}
              onClick={() => void discard()}
            >
              {finishPending === "discard"
                ? t("controls.discard.pending")
                : t("controls.discard.confirm")}
            </button>
          </div>
        </section>
      )}

      {terminalConfirm && (
        <section
          className="recording-terminal-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="recording-terminal-title"
          aria-describedby="recording-terminal-description"
        >
          <div>
            <h2 id="recording-terminal-title">{t("controls.terminalConfirm.title")}</h2>
            <p id="recording-terminal-description">
              {t("controls.terminalConfirm.description")}
            </p>
          </div>
          <div className="recording-discard-actions">
            <button
              className="recording-keep"
              onClick={() => setTerminalConfirm(null)}
            >
              {t("controls.discard.keep")}
            </button>
            <button
              className={
                terminalConfirm === "discard"
                  ? "recording-confirm-discard"
                  : "recording-close-terminal"
              }
              onClick={() => {
                const intent = terminalConfirm;
                setTerminalConfirm(null);
                if (intent === "discard") void discard(true);
                else void done(true);
              }}
            >
              {terminalConfirm === "discard"
                ? t("controls.terminalConfirm.discard")
                : t("controls.terminalConfirm.save")}
            </button>
          </div>
        </section>
      )}

      {showMicrophoneMenu && (
        <section
          ref={microphoneMenuRef}
          className="recording-microphone-menu"
          aria-label={t("controls.microphone.choose")}
        >
          <header>
            <strong>{t("controls.microphone.heading")}</strong>
            <span>
              {microphoneOn
                ? t("controls.microphone.using", { device: activeMicrophoneLabel })
                : t("controls.microphone.next", {
                    device: microphoneSettings?.selectedDeviceLabel ?? systemDefaultLabel,
                  })}
            </span>
          </header>
          <div
            className="recording-microphone-options"
            role="radiogroup"
            aria-label={t("controls.microphone.group")}
          >
            {microphoneSettings?.devices.map((device) => {
              const selected =
                device.id === microphoneSettings.selectedDeviceId;
              return (
                <button
                  key={device.id}
                  className={selected ? "selected" : ""}
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  disabled={devicePending || finishPending !== null}
                  onClick={() => void selectMicrophone(device.id)}
                >
                  <span>{device.label}</span>
                  {selected && (
                    <span className="recording-microphone-selected">
                      {t("controls.microphone.selected")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {error && (
            <p
              className={
                actionError ||
                status?.microphone.error ||
                microphoneSettings?.error
                  ? "error"
                  : "warn"
              }
              role={
                actionError ||
                status?.microphone.error ||
                microphoneSettings?.error
                  ? "alert"
                  : undefined
              }
            >
              {error}
            </p>
          )}
        </section>
      )}

      <div className="recording-bar-wrap">
        <div className="recording-bar">
          <div className="recording-live" role="status" aria-label={`${captureLabel} ${formatMs(elapsed)}`}>
            <span className="recording-live-dot" aria-hidden />
            <span className="recording-live-copy">
              <strong>{captureLabel}</strong>
              <span>{formatMs(elapsed)}</span>
            </span>
          </div>

          <span className="recording-divider" aria-hidden />

          <div
            ref={microphoneControlRef}
            className={`recording-microphone-split ${
              microphoneOn ? "on" : ""
            } ${microphoneError ? "error" : ""}`}
          >
            <button
              className="recording-microphone"
              disabled={lifecycleBusy || microphoneBusy}
              aria-label={
                microphoneOn
                  ? t("controls.microphone.muteAria", {
                      device: activeMicrophoneLabel,
                      language: narrationLanguage,
                    })
                  : microphoneError
                    ? t("controls.microphone.retryAria", {
                        error: status?.microphone.error ?? "",
                      })
                    : t("controls.microphone.unmuteAria", {
                        device: microphoneSettings?.selectedDeviceLabel ?? systemDefaultLabel,
                        language: narrationLanguage,
                      })
              }
              aria-pressed={microphoneOn}
              title={
                microphoneOn
                  ? t("controls.microphone.muteTitle", {
                      device: activeMicrophoneLabel,
                      language: narrationLanguage,
                    })
                  : t("controls.microphone.unmuteTitle", {
                      device: microphoneSettings?.selectedDeviceLabel ?? systemDefaultLabel,
                      language: narrationLanguage,
                    })
              }
              onClick={() => void toggleMicrophone()}
            >
              <MicrophoneIcon off={!microphoneOn} />
              <span>{microphoneLabel}</span>
            </button>
            <button
              className="recording-microphone-menu-toggle"
              disabled={lifecycleBusy || microphoneBusy}
              aria-label={t("controls.microphone.choose")}
              aria-haspopup="dialog"
              aria-expanded={showMicrophoneMenu}
              title={t("controls.microphone.choose")}
              onClick={() => {
                setActionError(null);
                setConfirmDiscard(false);
                setShowMicrophoneMenu((open) => !open);
              }}
            >
              <ChevronIcon open={showMicrophoneMenu} />
            </button>
          </div>

          <button
            className={`recording-terminal ${
              terminalStatus?.state !== "closed" ? "active" : ""
            } ${terminalStatus?.state === "error" ? "error" : ""}`}
            disabled={lifecycleBusy || terminalPending}
            aria-label={
              terminalStatus?.state === "closed"
                ? t("controls.terminal.openAria")
                : t("controls.terminal.focusAria", { state: terminalStatus?.state ?? "" })
            }
            title={t("controls.terminal.title")}
            onClick={() => void openTerminal()}
          >
            <TerminalIcon />
            <span>
              {terminalPending ? t("controls.terminal.opening") : t("controls.terminal.label")}
            </span>
            {terminalStatus?.state !== "closed" && (
              <span
                className={`recording-terminal-dot ${
                  terminalStatus?.state ?? "closed"
                }`}
                aria-hidden
              />
            )}
          </button>

          <button
            className="recording-discard"
            disabled={lifecycleBusy}
            onClick={() => {
              setActionError(null);
              setShowMicrophoneMenu(false);
              setConfirmDiscard(true);
            }}
          >
            {t("controls.discard.action")}
          </button>
          <button className="recording-done" disabled={lifecycleBusy} onClick={() => void done(false)}>
            {finishPending === "done" || status?.transition === "stopping"
              ? t("controls.done.pending")
              : t("controls.done.action")}
          </button>
        </div>
        <span className="recording-drag-handle" aria-hidden />
      </div>

      <span className="recording-controls-live" aria-live="polite">
        {error ?? ""}
      </span>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
    >
      <path
        d={open ? "m3 7.5 3-3 3 3" : "m3 4.5 3 3 3-3"}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="17" height="16" viewBox="0 0 18 16" fill="none" aria-hidden>
      <rect x="1.5" y="2" width="15" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="m4.5 6 2 2-2 2M9 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicrophoneIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5 9.2a5 5 0 0 0 8.9 3.1M10 14.2v3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {!off && (
        <path
          d="M15 9.2c0 .7-.14 1.36-.4 1.96"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
      {off && (
        <path
          d="M3.2 3.2 16.8 16.8"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
