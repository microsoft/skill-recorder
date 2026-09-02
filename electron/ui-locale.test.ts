import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { UiLocaleStore } from "./ui-locale";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "skill-recorder-ui-locale-"));
}

test("with no stored choice the OS locale decides the interface language", () => {
  assert.equal(new UiLocaleStore({ dir: freshDir(), systemLocale: "zh-Hans-CN" }).current(), "zh-CN");
  assert.equal(new UiLocaleStore({ dir: freshDir(), systemLocale: "en-US" }).current(), "en");
  // Unsupported OS locales get English, not a missing catalogue.
  assert.equal(new UiLocaleStore({ dir: freshDir(), systemLocale: "fr-FR" }).current(), "en");
});

test("an explicit choice persists, overrides the OS locale, and notifies once", () => {
  const dir = freshDir();
  const seen: string[] = [];
  const store = new UiLocaleStore({
    dir,
    systemLocale: "en-US",
    onChange: (locale) => seen.push(locale),
  });

  assert.equal(store.set("zh-CN"), "zh-CN");
  // Re-selecting the active locale is a no-op, so windows aren't re-rendered.
  assert.equal(store.set("zh-CN"), "zh-CN");
  assert.deepEqual(seen, ["zh-CN"]);

  const reopened = new UiLocaleStore({ dir, systemLocale: "en-US" });
  assert.equal(reopened.current(), "zh-CN");
});

test("an unsupported locale is refused rather than applied", () => {
  const store = new UiLocaleStore({ dir: freshDir(), systemLocale: "en-US" });

  assert.equal(store.set("zh-TW" as never), "en");
  assert.equal(store.current(), "en");
});

test("a malformed or unsupported preference file falls back to the OS locale", () => {
  for (const contents of ["not json", "null", "[]", '{"locale":"zh-TW"}', "{}"]) {
    const dir = freshDir();
    writeFileSync(path.join(dir, "ui-locale.json"), contents);
    assert.equal(
      new UiLocaleStore({ dir, systemLocale: "zh-CN" }).current(),
      "zh-CN",
      contents,
    );
  }
});

test("a failed write still applies the choice for this session", () => {
  const errors: unknown[] = [];
  // A path whose parent is a file cannot be created, standing in for a
  // read-only or otherwise unwritable userData directory.
  const dir = freshDir();
  const blocked = path.join(dir, "blocker");
  writeFileSync(blocked, "");
  const store = new UiLocaleStore({
    dir: path.join(blocked, "nested"),
    systemLocale: "en-US",
    onPersistError: (error) => errors.push(error),
  });

  assert.equal(store.set("zh-CN"), "zh-CN");
  assert.equal(errors.length, 1);
});
