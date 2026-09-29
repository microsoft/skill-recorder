import { useEffect, useRef } from "react";

import type { SensitiveModelStatus } from "../common/ipc";
import { useI18n } from "./i18n";

function protectionModelNote(
  t: (key: "loading" | "modelReady" | "modelSettingUp" | "modelSetupFailed" | "modelMissing") => string,
  status: SensitiveModelStatus | null,
): string {
  if (!status) return t("loading");
  switch (status.ocr) {
    case "ready":
      return t("modelReady");
    case "downloading":
      return status.progress == null
        ? t("modelSettingUp")
        : `${t("modelSettingUp")} ${Math.round(status.progress)}%`;
    case "error":
      return t("modelSetupFailed");
    default:
      return t("modelMissing");
  }
}

export function WhatsRecorded({
  onClose,
  onReviewed,
  sensitive,
  advancedPending,
  onToggleAdvanced,
  onDownload,
}: {
  onClose: () => void;
  onReviewed: () => void;
  sensitive: SensitiveModelStatus | null;
  advancedPending: boolean;
  onToggleAdvanced: () => void;
  onDownload: () => void;
}) {
  const { t } = useI18n();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheetRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const advancedOn = sensitive?.enabled ?? true;
  const showModelError = advancedOn && sensitive?.ocr === "error";
  const showDownloadAction = advancedOn && (sensitive?.ocr === "error" || sensitive?.ocr === "missing");

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-recorded-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <span className="sheet-icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 2.5 4 4.8v4.3c0 3.4 2.4 6.2 6 7.4 3.6-1.2 6-4 6-7.4V4.8L10 2.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="m7.4 9.8 1.9 1.9 3.4-3.6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h2 id="whats-recorded-title">{t("whatsRecorded")}</h2>
        </header>

        <p className="sheet-lead">{t("privacyLead")}</p>

        <section className="sheet-block">
          <h3>{t("whileRecording")}</h3>
          <p className="sheet-note">{t("onlyBetweenStartStop")}</p>
          <ul>
            <li>{t("captureApps")}</li>
            <li>{t("captureUrls")}</li>
            <li>{t("captureClipboard")}</li>
            <li>{t("captureVideo")}</li>
            <li>{t("captureRecordedTerminal")}</li>
          </ul>
          <p className="sheet-caution">{t("sensitiveCaptureWarning")}</p>
        </section>

        <section className="sheet-block">
          <h3>{t("recordedTerminalIfOpened")}</h3>
          <ul>
            <li>{t("onlyTerminalOpenedFromBar")}</li>
            <li>{t("fullTerminalOutputStored")}</li>
            <li>{t("recorderDoesNotWatchTerminals")}</li>
          </ul>
        </section>

        <section className="sheet-block">
          <h3>{t("voiceNarrationIfOn")}</h3>
          <p className="sheet-note">{t("narrationOffDefault")}</p>
          <ul>
            <li>{t("narrationPermissionDetail")}</li>
            <li>{t("narrationSavedDetail")}</li>
            <li>{t("narrationSegmentsDetail")}</li>
            <li>{t("narrationModelDetail")}</li>
            <li>{t("narrationNoMicDetail")}</li>
          </ul>
        </section>

        <section className="sheet-block">
          <h3>{t("whereStored")}</h3>
          <ul>
            <li>{t("localStorageDetail")}</li>
            <li>{t("retentionDetail")}</li>
          </ul>
        </section>

        <section className="sheet-block">
          <h3>{t("whatsSentForAnalysis")}</h3>
          <ul>
            <li>{t("nothingLeavesWhileRecording")}</li>
            <li>{t("analysisSentDetail")}</li>
            <li>{t("defaultProtectionDetail")}</li>
          </ul>
        </section>

        <section className={`sheet-block sheet-advp ${advancedOn ? "on" : ""}`}>
          <div className="sheet-advp-head">
            <div className="sheet-advp-copy">
              <h3>{t("advancedProtection")}</h3>
              <p className="sheet-note">{t("protectionDescription")}</p>
            </div>
            <button
              type="button"
              className="sheet-switch-btn"
              role="switch"
              aria-checked={advancedOn}
              aria-busy={advancedPending}
              aria-label={t("advancedProtection")}
              disabled={advancedPending}
              onClick={onToggleAdvanced}
            >
              <span className={`sheet-switch ${advancedOn ? "on" : ""}`} aria-hidden>
                <span className="sheet-switch-knob" />
              </span>
            </button>
          </div>
          {advancedOn && (
            <>
              <ul>
                <li>{t("protectionHides")}</li>
                <li>{t("protectionOffRisk")}</li>
                <li>{t("runsLocally")}</li>
              </ul>
              <div className={`sheet-advp-status ${showModelError ? "is-error" : ""}`}>
                <span className="sheet-advp-model">
                  {protectionModelNote(t as never, sensitive)}
                </span>
                {showDownloadAction && (
                  <button type="button" className="sheet-advp-download" onClick={onDownload}>
                    {sensitive?.ocr === "error" ? t("retry") : t("setupNow")}
                  </button>
                )}
              </div>
              <p className="sheet-caution">{t("protectionLimit")}</p>
            </>
          )}
        </section>

        <section className="sheet-block">
          <h3>{t("whatItNeverDoes")}</h3>
          <ul>
            <li>{t("neverKeystrokes")}</li>
            <li>{t("neverTerminalApps")}</li>
            <li>{t("captureOnlyActive")}</li>
          </ul>
        </section>

        <button className="sheet-close" onClick={onReviewed}>
          {t("gotIt")}
        </button>
      </div>
    </div>
  );
}
