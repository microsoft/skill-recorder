import assert from "node:assert/strict";
import test from "node:test";

import { en, type MessageKey } from "./en";
import { interpolate, translate } from "./translate";
import { zhCN } from "./zh-CN";

const CATALOGUE = { greeting: "你好 {name}", blank: "" };
const FALLBACK = { greeting: "Hello {name}", blank: "Fallback", only: "English only" };

test("translate prefers the locale message and falls back to English per message", () => {
  assert.equal(translate("greeting", { name: "Ada" }, CATALOGUE, FALLBACK), "你好 Ada");
  // Untranslated and empty-string entries both fall back rather than blanking the UI.
  assert.equal(translate("only", undefined, CATALOGUE, FALLBACK), "English only");
  assert.equal(translate("blank", undefined, CATALOGUE, FALLBACK), "Fallback");
  // An unknown key surfaces as itself instead of rendering an empty element.
  assert.equal(translate("missing", undefined, CATALOGUE, FALLBACK), "missing");
});

test("interpolation fills supplied vars and leaves the rest visible", () => {
  assert.equal(interpolate("Mute {device} · {language}", { device: "Mic" }), "Mute Mic · {language}");
  assert.equal(interpolate("No vars here"), "No vars here");
  assert.equal(interpolate("Count {n}", { n: 3 }), "Count 3");
});

test("zh-CN only defines keys that exist in English, and none are blank", () => {
  for (const [key, value] of Object.entries(zhCN)) {
    assert.ok(key in en, `zh-CN has a stale key: ${key}`);
    assert.notEqual(value, "", `zh-CN leaves ${key} blank`);
  }
});

test("zh-CN keeps every placeholder its English message uses", () => {
  const placeholders = (message: string) =>
    new Set(message.match(/\{\w+\}/g) ?? []);

  for (const [key, value] of Object.entries(zhCN)) {
    assert.deepEqual(
      placeholders(value as string),
      placeholders(en[key as MessageKey]),
      `zh-CN changes the placeholders in ${key}`,
    );
  }
});
