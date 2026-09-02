import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isUiLocale, resolveUiLocale, type UiLocale } from "../common/locale";

const FILE_NAME = "ui-locale.json";

export interface UiLocaleStoreOptions {
  /** Directory holding the preference file — the app's `userData` path. */
  dir: string;
  /** OS locale, used until the user picks a language explicitly. */
  systemLocale: string;
  /** Called after the effective locale changes, to broadcast it to every window. */
  onChange?: (locale: UiLocale) => void;
  /** Called when the choice could not be written to disk; the change still
   *  applies for this session. Persistence is a preference, not a recording,
   *  so a read-only `userData` must not fail the action or crash the app. */
  onPersistError?: (error: unknown) => void;
}

/**
 * The app's interface language: an explicit choice if one was stored, otherwise
 * whatever the OS reports. Kept free of `electron` imports so it can be tested
 * under plain Node — `main.ts` injects `app.getPath("userData")` and
 * `app.getLocale()`.
 */
export class UiLocaleStore {
  private readonly file: string;
  private readonly options: UiLocaleStoreOptions;
  private locale: UiLocale;

  constructor(options: UiLocaleStoreOptions) {
    this.options = options;
    this.file = path.join(options.dir, FILE_NAME);
    this.locale = this.read() ?? resolveUiLocale(options.systemLocale);
  }

  current(): UiLocale {
    return this.locale;
  }

  /** Apply and persist an explicit choice. Unsupported values are ignored so a
   *  stale renderer cannot push the UI into a locale with no catalogue. */
  set(locale: UiLocale): UiLocale {
    if (!isUiLocale(locale) || locale === this.locale) return this.locale;
    this.locale = locale;
    this.write(locale);
    this.options.onChange?.(locale);
    return this.locale;
  }

  /** A missing, unreadable, malformed or unsupported file means "no explicit
   *  choice" — never a startup failure. */
  private read(): UiLocale | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const stored = (parsed as { locale?: unknown }).locale;
    return isUiLocale(stored) ? stored : null;
  }

  private write(locale: UiLocale): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ locale }, null, 2)}\n`);
    } catch (error) {
      this.options.onPersistError?.(error);
    }
  }
}
