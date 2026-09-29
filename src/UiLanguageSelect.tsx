import type { UiLanguagePreference } from "../common/locales";
import { UI_LOCALES } from "../common/locales";
import { useI18n } from "./i18n";

export function UiLanguageSelect(): React.ReactElement {
  const { preference, t, setPreference } = useI18n();
  return (
    <>
      <label htmlFor="ui-language">{t("interfaceLanguage")}</label>
      <div className="narrate-select-wrap">
        <select
          id="ui-language"
          value={preference ?? "system"}
          title={t("interfaceLanguageHelp")}
          onChange={(event) => {
            const value = event.currentTarget.value;
            void setPreference((value === "system" ? null : value) as UiLanguagePreference);
          }}
        >
          <option value="system">{t("followSystem")}</option>
          {UI_LOCALES.map(({ code, label }) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <span className="narrate-select-chevron" aria-hidden>
          ▾
        </span>
      </div>
    </>
  );
}
