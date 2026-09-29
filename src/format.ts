import type { UiLocale } from "../common/locales";

/** Timecode counter — mm:ss, for the live recorder readout. */
export function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Compact duration, e.g. "9s" or "1m 12s". */
export function formatDur(ms: number, locale: UiLocale = "en"): string {
  const s = Math.round(ms / 1000);
  if (locale === "zh-CN") {
    if (s < 60) return `${s}秒`;
    return `${Math.floor(s / 60)}分 ${s % 60}秒`;
  }
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Compact binary file size, e.g. "824 KB" or "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`;
}

/**
 * Compact one-line label derived from a full intent sentence. Used as the
 * sessions-list name when an analysis has no short `title` (older analyses saved
 * before the describer produced one). Trims to a word boundary near 44 chars so
 * the list stays scannable instead of wrapping the whole goal sentence.
 */
export function shortLabel(intent: string): string {
  const clean = intent.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  if (clean.length <= 44) return clean;
  const cut = clean.slice(0, 44);
  const sp = cut.lastIndexOf(" ");
  return (sp > 24 ? cut.slice(0, sp) : cut).replace(/[,;:]+$/, "") + "…";
}

/** Human timestamp for a saved session, e.g. "Jul 25, 1:05 AM". */
export function formatWhen(ms: number | null, locale: UiLocale = "en"): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(locale === "en" ? undefined : locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
