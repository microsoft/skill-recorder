import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isUiLocale,
  resolveUiLocale,
  type UiLanguagePreference,
  type UiLanguageState,
} from "./locales";

export const UI_LANGUAGE_FILE = "ui-language.json";

export function parseUiLanguage(raw: string, systemLocale: string): UiLanguageState {
  try {
    const value = (JSON.parse(raw) as { uiLocale?: unknown }).uiLocale;
    const preference = value === null || value === undefined ? null : isUiLocale(value) ? value : null;
    return { preference, effective: preference ?? resolveUiLocale(systemLocale) };
  } catch {
    return { preference: null, effective: resolveUiLocale(systemLocale) };
  }
}

export async function loadUiLanguage(userData: string, systemLocale: string): Promise<UiLanguageState> {
  try {
    return parseUiLanguage(await readFile(path.join(userData, UI_LANGUAGE_FILE), "utf8"), systemLocale);
  } catch {
    return { preference: null, effective: resolveUiLocale(systemLocale) };
  }
}

export async function saveUiLanguage(
  userData: string,
  preference: UiLanguagePreference,
  systemLocale: string,
): Promise<UiLanguageState> {
  const state = { preference, effective: preference ?? resolveUiLocale(systemLocale) };
  await mkdir(userData, { recursive: true });
  const file = path.join(userData, UI_LANGUAGE_FILE);
  const temporary = `${file}.next`;
  await writeFile(temporary, `${JSON.stringify({ uiLocale: preference }, null, 2)}
`, "utf8");
  await rename(temporary, file);
  return state;
}
