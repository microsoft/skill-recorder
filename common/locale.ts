/**
 * UI locales for the app's own chrome.
 *
 * Deliberately separate from `common/narration.ts`: that module picks the
 * language a recording's narration is *transcribed* in, and it is also
 * unrelated to the language of a generated Skill or Automation. Changing the
 * interface language must not change either of those.
 *
 * English is the source language — every message exists in `en`, so it is both
 * the default and the per-message fallback for a partially translated locale.
 */

export const UI_LOCALES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
] as const;

export type UiLocale = (typeof UI_LOCALES)[number]["code"];

export const DEFAULT_UI_LOCALE: UiLocale = "en";

export function isUiLocale(value: unknown): value is UiLocale {
  return UI_LOCALES.some(({ code }) => code === value);
}

/** The locale's own endonym, so the picker is readable to speakers of that language. */
export function uiLocaleLabel(locale: UiLocale): string {
  return UI_LOCALES.find(({ code }) => code === locale)?.label ?? locale;
}

/** Simplified-Chinese regions. `zh-TW`/`zh-HK`/`zh-MO` are Traditional and are
 *  not served by the `zh-CN` catalogue, so they fall back to English until a
 *  Traditional catalogue exists. */
const SIMPLIFIED_CHINESE_REGIONS = new Set(["cn", "sg", "my"]);

/**
 * Map an OS locale tag onto a supported UI locale.
 *
 * Handles the shapes Electron's `app.getLocale()` and `navigator.language`
 * actually produce — `"en"`, `"en-GB"`, `"zh-CN"`, `"zh-Hans-CN"`, `"zh_TW"` —
 * and falls back to English for anything unsupported or unparseable.
 */
export function resolveUiLocale(systemLocale: string | null | undefined): UiLocale {
  if (typeof systemLocale !== "string") return DEFAULT_UI_LOCALE;
  const subtags = systemLocale.trim().replace(/_/g, "-").split("-").filter(Boolean);
  if (subtags.length === 0) return DEFAULT_UI_LOCALE;

  const language = subtags[0].toLowerCase();
  if (language === "en") return "en";
  if (language !== "zh") return DEFAULT_UI_LOCALE;

  // Script wins over region: `zh-Hant-CN` is Traditional despite the CN region.
  const script = subtags.slice(1).find((tag) => tag.length === 4)?.toLowerCase();
  if (script === "hant") return DEFAULT_UI_LOCALE;
  if (script === "hans") return "zh-CN";

  const region = subtags.slice(1).find((tag) => tag.length === 2 || tag.length === 3);
  // Bare `zh` means Simplified in practice — it is what Windows and Chrome
  // report for a Simplified install that omits the region.
  if (region === undefined) return "zh-CN";
  return SIMPLIFIED_CHINESE_REGIONS.has(region.toLowerCase())
    ? "zh-CN"
    : DEFAULT_UI_LOCALE;
}
