import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UI_LOCALE,
  isUiLocale,
  resolveUiLocale,
  UI_LOCALES,
  uiLocaleLabel,
} from "./locale";

test("UI locales are unique, labelled by endonym, and default to English", () => {
  const codes = UI_LOCALES.map(({ code }) => code);

  assert.equal(new Set(codes).size, UI_LOCALES.length);
  assert.equal(DEFAULT_UI_LOCALE, "en");
  assert.ok(codes.includes(DEFAULT_UI_LOCALE));
  assert.equal(uiLocaleLabel("en"), "English");
  assert.equal(uiLocaleLabel("zh-CN"), "简体中文");
  assert.equal(isUiLocale("zh-CN"), true);
  assert.equal(isUiLocale("zh-TW"), false);
  assert.equal(isUiLocale(undefined), false);
});

test("system locales resolve to a supported UI locale", () => {
  for (const tag of ["en", "en-US", "en-GB", "EN-gb"]) {
    assert.equal(resolveUiLocale(tag), "en", tag);
  }
  for (const tag of ["zh", "zh-CN", "zh_CN", "zh-Hans", "zh-Hans-CN", "zh-SG", "ZH-cn"]) {
    assert.equal(resolveUiLocale(tag), "zh-CN", tag);
  }
});

test("Traditional Chinese and unsupported locales fall back to English", () => {
  // No Traditional catalogue ships yet, and script beats region in `zh-Hant-CN`.
  for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-CN"]) {
    assert.equal(resolveUiLocale(tag), DEFAULT_UI_LOCALE, tag);
  }
  for (const tag of ["fr-FR", "ja", "de-DE", "", "   ", "-", null, undefined, 42]) {
    assert.equal(resolveUiLocale(tag as string), DEFAULT_UI_LOCALE, String(tag));
  }
});
