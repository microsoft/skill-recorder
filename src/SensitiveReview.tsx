import { useState } from "react";

import type { SensitiveFinding, SensitiveReport } from "../common/ipc";
import { sourceLabel } from "../common/sensitive";
import { useI18n } from "./i18n";

const SEVERITY_KEY: Record<SensitiveFinding["severity"], "highRisk" | "possiblySensitive" | "lowConfidence"> = {
  high: "highRisk",
  medium: "possiblySensitive",
  low: "lowConfidence",
};

function detailPhrase(locale: "en" | "zh-CN", count: number): string {
  return locale === "zh-CN"
    ? `${count} 条敏感信息`
    : `${count} sensitive ${count === 1 ? "detail" : "details"}`;
}

function areaPhrase(locale: "en" | "zh-CN", count: number): string {
  return locale === "zh-CN"
    ? `${count} 个屏幕区域`
    : `${count} on-screen ${count === 1 ? "area" : "areas"}`;
}

function headline(locale: "en" | "zh-CN", t: (key: keyof any, params?: Record<string, string | number>) => string, report: SensitiveReport): string {
  const findings = report.totalFindings;
  const regions = report.images?.regionsBlurred ?? 0;
  const details = detailPhrase(locale, findings);
  const areas = areaPhrase(locale, regions);
  if (locale === "zh-CN") {
    if (findings > 0 && regions > 0) return `发送前已隐藏 ${details} 并模糊 ${areas}`;
    if (findings > 0) return `发送前已隐藏 ${details}`;
    if (regions > 0) return `发送前已模糊 ${areas}`;
    return t("checkedForSensitive") as string;
  }
  if (findings > 0 && regions > 0) return `Hid ${details} and blurred ${areas} before sending`;
  if (findings > 0) return `Hid ${details} before sending`;
  if (regions > 0) return `Blurred ${areas} in screen images before sending`;
  return t("checkedForSensitive") as string;
}

export function SensitiveReview({
  report,
  onDismiss,
}: {
  report: SensitiveReport;
  onDismiss: () => void;
}) {
  const { effective, t } = useI18n();
  const [open, setOpen] = useState(false);
  const regions = report.images?.regionsBlurred ?? 0;
  const frames = report.images?.framesBlurred ?? 0;
  const hasDetails = report.findings.length > 0 || regions > 0;
  const locale = effective as "en" | "zh-CN";
  const frameLabel = frames === 1 ? t("oneImage") : t("manyImages", { count: frames });

  return (
    <section className="sensitive-review" role="status" aria-live="polite">
      <div className="sensitive-review-bar">
        <svg
          className="sensitive-review-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8 1.75 3 3.6v3.7c0 3.05 2.13 5.26 5 6.65 2.87-1.39 5-3.6 5-6.65V3.6L8 1.75Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M5.75 8.05 7.3 9.6l3.05-3.35"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="sensitive-review-headline">{headline(locale, t as never, report)}</p>
        {hasDetails && (
          <button className="sensitive-review-toggle linky" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? t("hideReview") : t("review")}
          </button>
        )}
        <button className="sensitive-dismiss linky" onClick={onDismiss} aria-label={t("dismiss")}>
          {t("dismiss")}
        </button>
      </div>

      {open && (
        <div className="sensitive-review-body">
          <div className="sensitive-scroll">
            {report.findings.length > 0 && (
              <ul className="sensitive-list">
                {report.findings.map((f, i) => (
                  <li key={`${f.source}-${f.label}-${i}`} className="sensitive-item">
                    <span className={`sensitive-dot sev-${f.severity}`} title={t(SEVERITY_KEY[f.severity])} aria-hidden="true" />
                    <div className="sensitive-item-body">
                      <div className="sensitive-item-head">
                        <span className="sensitive-label">{f.label}</span>
                        <span className="sensitive-source">{sourceLabel(f.source)}</span>
                        {f.occurrences > 1 && <span className="sensitive-count">×{f.occurrences}</span>}
                      </div>
                      <code className="sensitive-snippet">{f.snippet}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {regions > 0 && (
              <div className="sensitive-item">
                <span className="sensitive-dot sev-high" aria-hidden="true" />
                <div className="sensitive-item-body">
                  <div className="sensitive-item-head">
                    <span className="sensitive-label">{t("blurredDetails")}</span>
                    <span className="sensitive-source">{t("screenImages")}</span>
                  </div>
                  <span className="sensitive-snippet">
                    {regions === 1
                      ? t("oneAreaCovered", { frames: frameLabel })
                      : t("manyAreasCovered", { regions, frames: frameLabel })}
                  </span>
                </div>
              </div>
            )}
          </div>

          <p className="sensitive-caveat">{t("sensitiveReviewCaveat")}</p>
        </div>
      )}
    </section>
  );
}
