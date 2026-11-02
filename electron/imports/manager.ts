import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import { app } from "electron";

import { buildBundle } from "../../common/bundle";
import { AUDIO_MANIFEST_VERSION } from "../../common/audio";
import { IMPORT_FILE, IMPORT_LIMITS, IMPORT_LIMIT_LABEL, ImportDetailsSchema, type ImportMetadata } from "../../common/import";
import { DEFAULT_NARRATION_LANGUAGE, NARRATION_FILE } from "../../common/narration";
import type { SessionMeta } from "../../common/types";
import { sessionDir, sessionsRoot } from "../recorder/session-store";
import { ImportMedia } from "./media";
import { ImportedFrames } from "./frames";
import { readSessionImport, writeImportJson } from "./metadata";
import { inspectImportTracks } from "./tracks";

export class ImportManager {
  private readonly jobs = new Map<string, AbortController>();
  private settled: Promise<void> = Promise.resolve();

  isBusy(id: string): boolean { return this.jobs.has(id); }
  cancel(id: string): void { this.jobs.get(id)?.abort(); }
  dispose(): void { for (const controller of this.jobs.values()) controller.abort(); }
  whenIdle(): Promise<void> { return this.settled; }

  async run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.jobs.has(id)) throw new Error("This import is already being processed.");
    if (this.jobs.size) throw new Error("Another recording import is being processed. Finish or cancel it first.");
    const controller = new AbortController();
    let finish!: () => void;
    this.settled = new Promise<void>((resolve) => { finish = resolve; });
    this.jobs.set(id, controller);
    try { return await work(controller.signal); }
    finally { this.jobs.delete(id); finish(); }
  }

  async select(file: string, signal: AbortSignal): Promise<string> {
    const extension = path.extname(file).toLowerCase();
    const info = await stat(file);
    if (![".mp4", ".webm"].includes(extension) || !info.isFile() || info.size <= 0 || info.size > IMPORT_LIMITS.bytes) {
      throw new Error(`Choose a recording within the import limits: ${IMPORT_LIMIT_LABEL}.`);
    }
    const id = `import-${randomUUID()}`;
    const root = sessionsRoot();
    const staging = path.join(root, `.import-${randomUUID()}`);
    const target = sessionDir(id);
    await mkdir(staging, { recursive: true });
    try {
      const name = extension === ".mp4" ? "import.mp4" : "import.webm";
      const copy = path.join(staging, name);
      let copiedBytes = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          copiedBytes += chunk.length;
          if (copiedBytes > IMPORT_LIMITS.bytes) callback(new Error("Recording exceeds the import size limit."));
          else callback(null, chunk);
        },
      });
      await pipeline(createReadStream(file), bounded, createWriteStream(copy, { flags: "wx" }), { signal });
      signal.throwIfAborted();
      const copied = await stat(copy);
      if (copied.size !== info.size || copied.size > IMPORT_LIMITS.bytes) {
        throw new Error("The source recording changed during import. Select it again.");
      }
      const { hasAudio } = inspectImportTracks(await readFile(copy), extension);
      const media = new ImportMedia(signal);
      let properties;
      try { properties = await media.open(copy, hasAudio, true); }
      finally { media.dispose(); }
      signal.throwIfAborted();
      const importedAt = Date.now();
      const imported: ImportMetadata = {
        version: 1, file: name, name: path.basename(file), importedAt, bytes: copied.size,
        ...properties, hasAudio, details: "", language: DEFAULT_NARRATION_LANGUAGE,
      };
      const meta: SessionMeta = {
        id, startedAt: importedAt, stoppedAt: importedAt + imported.durationMs,
        platform: process.platform, appVersion: app.getVersion(), source: "imported-video",
      };
      await mkdir(path.join(staging, "frames"));
      await writeFile(path.join(staging, "events.jsonl"), "");
      await writeImportJson(staging, IMPORT_FILE, imported);
      await writeImportJson(staging, "session.json", meta);
      await writeImportJson(staging, "video.json", {
        file: name, startEpoch: importedAt, stopEpoch: meta.stoppedAt,
        durationMs: imported.durationMs, bytes: copied.size, fps: 0,
      });
      await this.writeAudio(staging, imported);
      signal.throwIfAborted();
      await rename(staging, target);
      if (signal.aborted) {
        await rm(target, { recursive: true, force: true });
        signal.throwIfAborted();
      }
      return id;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async saveDetails(id: string, input: unknown): Promise<void> {
    if (this.isBusy(id)) throw new Error("Wait for this import's processing to finish.");
    const details = ImportDetailsSchema.parse(input);
    const dir = sessionDir(id);
    const imported = readSessionImport(dir);
    if (!imported) throw new Error("This is not an imported recording.");
    if (details.language !== imported.language) {
      await rm(path.join(dir, NARRATION_FILE), { force: true });
    }
    const next = { ...imported, ...details };
    await writeImportJson(dir, IMPORT_FILE, next);
    await this.writeAudio(dir, next);
  }

  private async writeAudio(dir: string, imported: ImportMetadata): Promise<void> {
    if (!imported.hasAudio) return;
    await writeImportJson(dir, "audio.json", {
      version: AUDIO_MANIFEST_VERSION, narrationLanguage: imported.language,
      segments: [{
        file: imported.file, startEpoch: imported.importedAt,
        stopEpoch: imported.importedAt + imported.durationMs,
        durationMs: imported.durationMs, bytes: imported.bytes,
        sessionStartMs: 0, sessionEndMs: imported.durationMs,
        videoStartMs: 0, videoEndMs: imported.durationMs,
      }],
    });
  }

  async prepare(id: string, signal: AbortSignal): Promise<void> {
    const dir = sessionDir(id);
    const imported = readSessionImport(dir);
    if (!imported) throw new Error("Imported recording metadata is missing.");
    const meta = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")) as SessionMeta;
    // Each analysis gets a fresh bounded frame budget; the original is always available for seeking.
    await rm(path.join(dir, "frames"), { recursive: true, force: true });
    await mkdir(path.join(dir, "frames"));
    const frames = new ImportedFrames(dir, imported, meta.startedAt);
    const cancel = () => frames.dispose();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      await frames.extractWindow({
        startMs: meta.startedAt, endMs: meta.startedAt + imported.durationMs,
        maxFrames: 24, reason: "import:overview",
      });
      signal.throwIfAborted();
      const bundle = buildBundle({ meta, events: [] });
      bundle.stats.frameCount = frames.manifest.length;
      await writeImportJson(dir, "bundle.json", bundle);
    } finally {
      signal.removeEventListener("abort", cancel);
      frames.dispose();
    }
  }
}
