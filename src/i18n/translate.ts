/**
 * The whole translation engine: a catalogue lookup with an English fallback and
 * `{name}` interpolation. Kept dependency-free and free of React on purpose —
 * the app ships a reviewed third-party manifest (see `scripts/compliance.mjs`
 * and `THIRD-PARTY-NOTICES.md`), so a runtime i18n library would need a
 * compliance review to buy behaviour this file covers in a few lines.
 */

/** English is complete by construction, so it types every key in the app. */
export type MessageCatalogue = Readonly<Record<string, string>>;

/** A translation may lag behind English; missing keys fall back per message. */
export type PartialMessageCatalogue = Readonly<Partial<Record<string, string>>>;

export type MessageVars = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Substitute `{name}` placeholders. An unsupplied placeholder is left intact so
 *  a missing variable shows up in review instead of silently rendering blank. */
export function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = vars[name];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Resolve `key` against `catalogue`, falling back to `fallback` for a message
 * that is missing or left empty by a translator, then to the key itself so a
 * typo is visible rather than rendering as an empty element.
 */
export function translate(
  key: string,
  vars: MessageVars | undefined,
  catalogue: PartialMessageCatalogue,
  fallback: MessageCatalogue,
): string {
  const translated = catalogue[key];
  const template =
    translated !== undefined && translated !== "" ? translated : fallback[key] ?? key;
  return interpolate(template, vars);
}
