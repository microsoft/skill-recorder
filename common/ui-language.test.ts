import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { loadUiLanguage, parseUiLanguage, saveUiLanguage, UI_LANGUAGE_FILE } from "./ui-language";

const baseDir = path.join(process.cwd(), ".ui-language-test-work");

async function withTestDir(name: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = path.join(baseDir, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("UI language persistence", () => {
  it("uses the system for null, corrupt, or invalid preferences", () => {
    assert.deepEqual(parseUiLanguage('{"uiLocale":null}', "zh-Hans"), { preference: null, effective: "zh-CN" });
    assert.deepEqual(parseUiLanguage("broken", "en-US"), { preference: null, effective: "en" });
    assert.deepEqual(parseUiLanguage('{"uiLocale":"fr"}', "zh-CN"), { preference: null, effective: "zh-CN" });
  });

  it("atomically saves and reloads an explicit preference", async () => {
    await withTestDir("explicit", async (dir) => {
      assert.deepEqual(await saveUiLanguage(dir, "en", "zh-CN"), { preference: "en", effective: "en" });
      assert.match(await readFile(path.join(dir, UI_LANGUAGE_FILE), "utf8"), /"en"/);
      assert.deepEqual(await loadUiLanguage(dir, "zh-CN"), { preference: "en", effective: "en" });
    });
  });
});
