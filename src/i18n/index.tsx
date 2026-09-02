import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_UI_LOCALE,
  resolveUiLocale,
  type UiLocale,
} from "../../common/locale";
import { en, type MessageKey } from "./en";
import { translate, type MessageVars, type PartialMessageCatalogue } from "./translate";
import { zhCN } from "./zh-CN";

const CATALOGUES: Record<UiLocale, PartialMessageCatalogue> = {
  en,
  "zh-CN": zhCN,
};

export type Translate = (key: MessageKey, vars?: MessageVars) => string;

interface UiLocaleContext {
  locale: UiLocale;
  t: Translate;
  /** Persists the choice in the main process, which then re-broadcasts it to
   *  every window — the recorder, controls, library and terminal each render in
   *  their own root, so they cannot share renderer state. */
  setLocale: (locale: UiLocale) => void;
}

const Context = createContext<UiLocaleContext | null>(null);

/** First paint uses the browser locale, which Electron derives from the OS, so
 *  a system-locale user never sees a flash of English. A stored manual override
 *  arrives from the main process on mount and re-renders once. */
function initialLocale(): UiLocale {
  if (typeof navigator === "undefined") return DEFAULT_UI_LOCALE;
  return resolveUiLocale(navigator.language);
}

export function UiLocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(initialLocale);

  useEffect(() => {
    const bridge = window.skillRecorder;
    if (!bridge?.uiLocale) return;
    void bridge.uiLocale().then(setLocaleState);
    return bridge.onUiLocaleChanged(setLocaleState);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<UiLocaleContext>(
    () => ({
      locale,
      t: (key, vars) => translate(key, vars, CATALOGUES[locale], en),
      setLocale: (next) => {
        setLocaleState(next);
        void window.skillRecorder?.setUiLocale?.(next);
      },
    }),
    [locale],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useUiLocaleContext(): UiLocaleContext {
  const context = useContext(Context);
  if (!context) throw new Error("useT must be used inside <UiLocaleProvider>");
  return context;
}

/** The translation function for the active locale. */
export function useT(): Translate {
  return useUiLocaleContext().t;
}

/** The active locale plus its setter, for the language picker in settings. */
export function useUiLocale(): { locale: UiLocale; setLocale: (locale: UiLocale) => void } {
  const { locale, setLocale } = useUiLocaleContext();
  return useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
}

export type { MessageKey };
