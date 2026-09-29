import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { MessageKey, MessageParams, UiLanguagePreference, UiLanguageState, UiLocale } from "../common/locales";
import { message } from "../common/locales";

interface I18nValue extends UiLanguageState {
  t: (key: MessageKey, params?: MessageParams) => string;
  setPreference: (preference: UiLanguagePreference) => Promise<void>;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }): React.ReactElement | null {
  const [state, setState] = useState<UiLanguageState | null>(null);

  useEffect(() => {
    let live = true;
    void window.skillRecorder.uiLanguage().then((next) => {
      if (live) setState(next);
    });
    const unsubscribe = window.skillRecorder.onUiLocaleChanged((next) => setState(next));
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (state) document.documentElement.lang = state.effective;
  }, [state]);

  const t = useCallback(
    (key: MessageKey, params?: MessageParams) => message(state?.effective ?? "en", key, params),
    [state],
  );
  const setPreference = useCallback(async (preference: UiLanguagePreference) => {
    setState(await window.skillRecorder.setUiLocale(preference));
  }, []);
  const value = useMemo(() => (state ? { ...state, t, setPreference } : null), [state, t, setPreference]);
  return value ? <I18nContext.Provider value={value}>{children}</I18nContext.Provider> : null;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function recordingCountLabel(locale: UiLocale, t: I18nValue["t"], count: number): string {
  if (locale === "en") return count === 1 ? t("recordingsCount", { count }) : t("recordingsCountPlural", { count });
  return t("recordingsCount", { count });
}
