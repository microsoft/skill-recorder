import { en, type MessageKey, type Messages } from "./en";
import { zhCN } from "./zh-CN";

export type MessageParams = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;

export const UI_LOCALES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
] as const;

export type UiLocale = (typeof UI_LOCALES)[number]["code"];
export type UiLanguagePreference = UiLocale | null;
export interface UiLanguageState {
  preference: UiLanguagePreference;
  effective: UiLocale;
}

export const DEFAULT_UI_LOCALE: UiLocale = "en";

export function isUiLocale(value: unknown): value is UiLocale {
  return UI_LOCALES.some(({ code }) => code === value);
}

export function uiLocaleLabel(locale: UiLocale): string {
  return UI_LOCALES.find(({ code }) => code === locale)?.label ?? locale;
}

const SIMPLIFIED_CHINESE_REGIONS = new Set(["cn", "sg", "my"]);

export function resolveUiLocale(systemLocale: string | null | undefined): UiLocale {
  if (typeof systemLocale !== "string") return DEFAULT_UI_LOCALE;
  const subtags = systemLocale.trim().replace(/_/g, "-").split("-").filter(Boolean);
  if (subtags.length === 0) return DEFAULT_UI_LOCALE;

  const language = subtags[0].toLowerCase();
  if (language === "en") return "en";
  if (language !== "zh") return DEFAULT_UI_LOCALE;

  const script = subtags.slice(1).find((tag) => tag.length === 4)?.toLowerCase();
  if (script === "hant") return DEFAULT_UI_LOCALE;
  if (script === "hans") return "zh-CN";

  const region = subtags.slice(1).find((tag) => tag.length === 2 || tag.length === 3);
  if (region === undefined) return "zh-CN";
  return SIMPLIFIED_CHINESE_REGIONS.has(region.toLowerCase()) ? "zh-CN" : DEFAULT_UI_LOCALE;
}

const CATALOGUES: Record<UiLocale, Partial<Messages>> = {
  en,
  "zh-CN": zhCN,
};

export function message(locale: UiLocale, key: MessageKey, params?: MessageParams): string {
  let value = (CATALOGUES[locale][key] ?? en[key]) as string;
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

export { en, zhCN };
export type { MessageKey, Messages };
