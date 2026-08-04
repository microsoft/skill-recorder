import { useCallback, useEffect, useRef, useState } from "react";

import type {
  MicrophoneSettingsStatus,
  RecorderStatus,
} from "../common/ipc";
import {
  DEFAULT_NARRATION_LANGUAGE,
  narrationLanguageLabel,
} from "../common/narration";
import { formatMs } from "./format";

export function RecordingControls() {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [microphoneSettings, setMicrophoneSettings] =
    useState<MicrophoneSettingsStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showMicrophoneMenu, setShowMicrophoneMenu] = useState(false);
  const [microphonePending, setMicrophonePending] = useState(false);
  const [devicePending, setDevicePending] = useState(false);
  const [finishPending, setFinishPending] = useState<"done" | "discard" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markerToast, setMarkerToast] = useState(false);
  const keepRecordingRef = useRef<HTMLButtonElement>(null);
  const microphoneControlRef = useRef<HTMLDivElement>(null);
  const microphoneMenuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void window.skillRecorder.status().then(setStatus);
    void window.skillRecorder.microphoneSettings().then(setMicrophoneSettings);
    const offStatus = window.skillRecorder.onStatusChanged(setStatus);
    const offMicrophones =
      window.skillRecorder.onMicrophoneSettingsChanged(setMicrophoneSettings);
    return () => {
      offStatus();
      offMicrophones();
    };
  }, []);

  // Non-blocking confirmation for the global "add marker" shortcut. Never
  // steals focus or pauses the recording — it just flashes and fades.
  useEffect(() => {
    return window.skillRecorder.onMarkerAdded(() => setMarkerToast(true));
  }, []);

  useEffect(() => {
    if (!markerToast) return;
    const timer = setTimeout(() => setMarkerToast(false), 2200);
    return () => clearTimeout(timer);
  }, [markerToast]);

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
    if (markerToast) setMarkerToast(false);
    setMicrophonePending(false);
    setDevicePending(false);
    setFinishPending(null);
  }, [confirmDiscard, markerToast, recording, showMicrophoneMenu]);

  useEffect(() => {
    void window.skillRecorder.setRecordingControlsExpanded(
      confirmDiscard || showMicrophoneMenu || markerToast,
    );
  }, [confirmDiscard, markerToast, showMicrophoneMenu]);

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
    if (!result.ok) setActionError(result.error ?? "Could not change the microphone.");
    setMicrophonePending(false);
  }, [status]);

  const selectMicrophone = useCallback(async (deviceId: string) => {
    setDevicePending(true);
    setActionError(null);
    const result = await window.skillRecorder.selectMicrophone(deviceId);
    setMicrophoneSettings(result.status);
    if (!result.ok) {
      setActionError(result.error ?? "Could not switch microphones.");
    } else {
      setShowMicrophoneMenu(false);
    }
    setDevicePending(false);
  }, []);

  const done = useCallback(async () => {
    setFinishPending("done");
    setActionError(null);
    const result = await window.skillRecorder.stop();
    if (!result.ok) {
      setActionError(result.error ?? "Could not stop the recording.");
      setFinishPending(null);
    }
  }, []);

  const discard = useCallback(async () => {
    setFinishPending("discard");
    setActionError(null);
    const result = await window.skillRecorder.discard();
    if (!result.ok) {
      const error = result.error ?? "Could not discard the recording.";
      setActionError(error);
      setFinishPending(null);
      window.alert(error);
    }
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
  const activeMicrophoneLabel =
    status?.microphone.activeDevice?.label ??
    microphoneSettings?.selectedDeviceLabel ??
    "System default";
  const microphoneLabel =
    status?.microphone.state === "starting"
      ? "Starting"
      : status?.microphone.state === "stopping"
        ? "Stopping"
        : microphoneOn
          ? "On"
          : microphoneError
            ? "Retry"
            : "Off";
  const error =
    actionError ??
    status?.microphone.error ??
    microphoneSettings?.error ??
    microphoneSettings?.fallback ??
    null;
  const captureLabel =
    status?.transition === "starting"
      ? "Starting"
      : status?.transition === "stopping"
        ? "Saving"
        : status?.transition === "discarding"
          ? "Discarding"
          : "Capturing";

  return (
    <div
      className={`recording-controls ${confirmDiscard ? "expanded" : ""}`}
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
            <h2 id="recording-discard-title">Discard this recording?</h2>
            <p id="recording-discard-description">
              Screen video, activity, and recorded voice segments will be permanently deleted.
            </p>
          </div>
          <div className="recording-discard-actions">
            <button
              ref={keepRecordingRef}
              className="recording-keep"
              disabled={finishPending === "discard"}
              onClick={() => setConfirmDiscard(false)}
            >
              Keep recording
            </button>
            <button
              className="recording-confirm-discard"
              disabled={finishPending === "discard"}
              onClick={() => void discard()}
            >
              {finishPending === "discard" ? "Discarding..." : "Discard recording"}
            </button>
          </div>
        </section>
      )}

      {markerToast && !confirmDiscard && !showMicrophoneMenu && (
        <section className="recording-marker-toast" role="status">
          <MarkerIcon />
          <span>Marker added</span>
        </section>
      )}

      {showMicrophoneMenu && (
        <section
          ref={microphoneMenuRef}
          className="recording-microphone-menu"
          aria-label="Choose microphone"
        >
          <header>
            <strong>Microphone</strong>
            <span>
              {microphoneOn
                ? `Using ${activeMicrophoneLabel}`
                : `Next: ${microphoneSettings?.selectedDeviceLabel ?? "System default"}`}
            </span>
          </header>
          <div
            className="recording-microphone-options"
            role="radiogroup"
            aria-label="Audio input"
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
                      Selected
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
                  ? `Mute ${activeMicrophoneLabel}. Narration is transcribed in ${narrationLanguage}.`
                  : microphoneError
                    ? `Retry microphone. ${status?.microphone.error ?? ""}`
                    : `Unmute ${microphoneSettings?.selectedDeviceLabel ?? "System default"} for ${narrationLanguage} narration`
              }
              aria-pressed={microphoneOn}
              title={
                microphoneOn
                  ? `Mute ${activeMicrophoneLabel} · ${narrationLanguage} transcript`
                  : `Unmute ${microphoneSettings?.selectedDeviceLabel ?? "System default"} · ${narrationLanguage} transcript`
              }
              onClick={() => void toggleMicrophone()}
            >
              <MicrophoneIcon off={!microphoneOn} />
              <span>{microphoneLabel}</span>
            </button>
            <button
              className="recording-microphone-menu-toggle"
              disabled={lifecycleBusy || microphoneBusy}
              aria-label="Choose microphone"
              aria-haspopup="dialog"
              aria-expanded={showMicrophoneMenu}
              title="Choose microphone"
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
            className="recording-discard"
            disabled={lifecycleBusy}
            onClick={() => {
              setActionError(null);
              setShowMicrophoneMenu(false);
              setConfirmDiscard(true);
            }}
          >
            Discard
          </button>
          <button className="recording-done" disabled={lifecycleBusy} onClick={() => void done()}>
            {finishPending === "done" || status?.transition === "stopping" ? "Saving..." : "Done"}
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

function MarkerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.5 9.7 5l3.8.55-2.75 2.68.65 3.77L8 10.2l-3.4 1.8.65-3.77L2.5 5.55 6.3 5 8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
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
