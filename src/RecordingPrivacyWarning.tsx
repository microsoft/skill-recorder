import { useEffect, useRef } from "react";

import { useI18n } from "./i18n";

export function RecordingPrivacyWarning({
  starting,
  onStart,
  onReview,
  onClose,
}: {
  starting: boolean;
  onStart: () => void;
  onReview: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    startRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !starting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, starting]);

  return (
    <div className="sheet-backdrop" onClick={starting ? undefined : onClose}>
      <div
        className="recording-warning"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-warning-title"
        aria-describedby="recording-warning-copy recording-warning-detail"
        aria-busy={starting}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="recording-warning-head">
          <span className="recording-warning-icon" aria-hidden>
            <svg width="19" height="19" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 2.5 4 4.8v4.3c0 3.4 2.4 6.2 6 7.4 3.6-1.2 6-4 6-7.4V4.8L10 2.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="M10 6.4v4.1M10 13.4h.01"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <h2 id="recording-warning-title">{t("beforeYouRecord")}</h2>
        </header>

        <p id="recording-warning-copy" className="recording-warning-copy">
          {t("beforeRecordWarning")}
        </p>
        <p id="recording-warning-detail" className="recording-warning-detail">
          {t("transparencyReview")}
        </p>

        <div className="recording-warning-actions">
          <button className="secondary" onClick={onReview} disabled={starting}>
            {t("seeExactlyWhatsCaptured")}
          </button>
          <button ref={startRef} className="record-cta" onClick={onStart} disabled={starting}>
            {starting ? t("starting") : t("startRecording")}
          </button>
        </div>
      </div>
    </div>
  );
}
