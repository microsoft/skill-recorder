import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  AiConnectionError, ByomConfigSchema, sameCredentialDestination,
  type AiConnectionStatus, type AiMode, type ByomConfig,
} from "../common/ai-provider";

export interface KeyProtector {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export function secureStorageAvailable(
  platform: NodeJS.Platform,
  storage: { isEncryptionAvailable(): boolean; getSelectedStorageBackend(): string },
): boolean {
  return storage.isEncryptionAvailable() && (platform !== "linux"
    || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(storage.getSelectedStorageBackend()));
}

const StoredConnectionSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["github", "byom"]).nullable(),
  profile: ByomConfigSchema.optional(),
  ciphertext: z.string().max(65536).optional(),
});
type StoredConnection = z.infer<typeof StoredConnectionSchema>;

/** Credentials never enter recording folders or the renderer's public status. */
export class AiProviderStore {
  private data: StoredConnection = { version: 1, mode: null };
  private key: string | undefined;
  private loading: Promise<void> | undefined;
  private warning: string | undefined;
  private secureFailed = false;

  constructor(private readonly file: () => string, private readonly protector: KeyProtector) {}

  private secure(): boolean {
    try { return !this.secureFailed && this.protector.available(); }
    catch {
      this.secureFailed = true;
      this.warning = "Secure key storage could not be opened. Keys will stay in memory.";
      return false;
    }
  }

  private load(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        this.data = StoredConnectionSchema.parse(JSON.parse(await readFile(this.file(), "utf8")));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        this.warning = "Saved AI settings could not be read. Configure the connection again.";
        return;
      }
      if (this.data.ciphertext && this.secure()) {
        try { this.key = this.protector.decrypt(Buffer.from(this.data.ciphertext, "base64")); }
        catch {
          this.warning = "The saved API key could not be unlocked. Enter it again.";
          this.secureFailed = true;
        }
      }
    })();
  }

  async status(): Promise<AiConnectionStatus> {
    await this.load();
    return {
      mode: this.data.mode,
      profile: this.data.profile ? { ...this.data.profile } : undefined,
      hasKey: !!this.key,
      storage: this.secure() ? "secure" : "memory",
      keyPersistence: this.key ? this.data.ciphertext ? "secure" : "memory" : "none",
      warning: this.warning,
    };
  }

  async credential(profile: ByomConfig): Promise<string | undefined> {
    await this.load();
    return sameCredentialDestination(this.data.profile, profile) ? this.key : undefined;
  }

  private async persist(next: StoredConnection): Promise<void> {
    const file = this.file();
    const temporary = `${file}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw new AiConnectionError("storage", "Could not remove temporary AI settings.");
      });
    }
  }

  async saveByom(profile: ByomConfig, key: string): Promise<AiConnectionStatus> {
    await this.load();
    let ciphertext: string | undefined;
    this.warning = undefined;
    if (this.secure()) {
      try { ciphertext = this.protector.encrypt(key).toString("base64"); }
      catch {
        this.secureFailed = true;
        this.warning = "Secure key storage became unavailable. The key is kept only in memory.";
      }
    }
    const next: StoredConnection = { version: 1, mode: "byom", profile, ciphertext };
    try { await this.persist(next); }
    catch {
      // Never let an old disk credential reappear after replacing it in memory.
      try { await unlink(this.file()); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw new AiConnectionError("storage", "Could not replace the previous saved key. Check access to the app's settings folder.");
        }
      }
      delete next.ciphertext;
      this.warning = "AI settings could not be saved. This connection will be used only until the app closes.";
    }
    this.data = next;
    this.key = key;
    return this.status();
  }

  async select(mode: AiMode): Promise<AiConnectionStatus> {
    await this.load();
    const next = { ...this.data, mode };
    try { await this.persist(next); }
    catch { throw new AiConnectionError("storage", "Could not save your AI connection choice."); }
    this.data = next;
    return this.status();
  }

  async forget(): Promise<AiConnectionStatus> {
    await this.load();
    const next = { ...this.data, ciphertext: undefined };
    try { await this.persist(next); }
    catch { throw new AiConnectionError("storage", "The saved key could not be removed. Check access to the app's settings folder and try again."); }
    this.data = next;
    this.key = undefined;
    this.warning = undefined;
    return this.status();
  }
}
