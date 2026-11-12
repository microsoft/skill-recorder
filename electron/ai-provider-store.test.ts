import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseByomConfig } from "../common/ai-provider";
import { AiProviderStore, secureStorageAvailable, type KeyProtector } from "./ai-provider-store";

const profile = parseByomConfig({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "vision-model", wireApi: "responses" });
const key = "test-only-private-provider-key";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-key-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ai-connection.json");
  let available = true;
  const protector: KeyProtector = {
    available: () => available,
    encrypt: (value) => Buffer.from([...value].reverse().join("")),
    decrypt: (value) => [...value.toString()].reverse().join(""),
  };
  return { file, protector, unavailable: () => { available = false; }, store: new AiProviderStore(() => file, protector) };
}

test("persists protected keys, restores them, and keeps public status secret-free", async (t) => {
  const f = await fixture(t);
  const status = await f.store.saveByom(profile, key);
  assert.equal(status.keyPersistence, "secure");
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.equal((await readFile(f.file, "utf8")).includes(key), false);
  const restored = new AiProviderStore(() => f.file, f.protector);
  assert.equal((await restored.status()).hasKey, true);
  assert.equal(await restored.credential(profile), key);
  assert.equal(await restored.credential({ ...profile, baseUrl: "https://other.example" }), undefined);
  await restored.select("github");
  assert.equal((await restored.status()).mode, "github");
  assert.equal(await restored.credential(profile), key);
  await restored.forget();
  assert.equal((await restored.status()).hasKey, false);
  assert.equal((await new AiProviderStore(() => f.file, f.protector).status()).hasKey, false);
});

test("unavailable storage is detected before input, never encrypts, and requires re-entry after restart", async (t) => {
  const f = await fixture(t);
  f.unavailable();
  f.protector.encrypt = () => { assert.fail("must not use insecure storage"); };
  assert.equal((await f.store.status()).storage, "memory");
  const status = await f.store.saveByom(profile, key);
  assert.equal(status.keyPersistence, "memory");
  assert.equal(await f.store.credential(profile), key);
  const disk = await readFile(f.file, "utf8");
  assert.equal(disk.includes(key), false);
  assert.equal(disk.includes("ciphertext"), false);
  const restored = await new AiProviderStore(() => f.file, f.protector).status();
  assert.equal(restored.hasKey, false);
  assert.equal(restored.profile?.model, profile.model);
  assert.equal(restored.mode, "byom");
});

test("encryption failure falls back without reviving an old credential", async (t) => {
  const f = await fixture(t);
  await f.store.saveByom(profile, "old-test-key");
  f.protector.encrypt = () => { throw new Error("locked"); };
  const status = await f.store.saveByom(profile, key);
  assert.equal(status.keyPersistence, "memory");
  assert.match(status.warning!, /memory/);
  assert.equal((await new AiProviderStore(() => f.file, f.protector).status()).hasKey, false);
});

test("unreadable saved keys and malformed settings surface safe warnings", async (t) => {
  const f = await fixture(t);
  await f.store.saveByom(profile, key);
  f.protector.decrypt = () => { throw new Error(key); };
  const status = await new AiProviderStore(() => f.file, f.protector).status();
  assert.equal(status.hasKey, false);
  assert.equal(status.storage, "memory");
  assert.match(status.warning!, /unlocked/);
  assert.equal(JSON.stringify(status).includes(key), false);
  await writeFile(f.file, "{broken");
  assert.match((await new AiProviderStore(() => f.file, f.protector).status()).warning!, /settings/);
});

test("forget does not claim success when persistent removal fails", async (t) => {
  const f = await fixture(t);
  await f.store.saveByom(profile, key);
  await unlink(f.file);
  await mkdir(f.file);
  await assert.rejects(f.store.forget(), /could not be removed/);
  assert.equal((await f.store.status()).hasKey, true);
});

test("OS protection requires a secure backend, not just an available encryptor", () => {
  const backend = (name: string, available = true) => ({
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => name,
  });
  assert.equal(secureStorageAvailable("linux", backend("basic_text")), false);
  assert.equal(secureStorageAvailable("linux", backend("unknown")), false);
  assert.equal(secureStorageAvailable("linux", backend("gnome_libsecret")), true);
  assert.equal(secureStorageAvailable("linux", backend("kwallet6", false)), false);
  assert.equal(secureStorageAvailable("win32", backend("unused")), true);
  assert.equal(secureStorageAvailable("darwin", backend("unused", false)), false);
});
