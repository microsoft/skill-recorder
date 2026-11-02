import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { FrameRecord } from "../../common/frames";
import { IMPORT_LIMITS, importSampleOffsets, type ImportMetadata } from "../../common/import";
import type { WindowRequest } from "../frames/extractor";
import { ImportMedia } from "./media";
import { writeImportJson } from "./metadata";

const RecordsSchema = z.array(z.object({
  file: z.string().regex(/^import_[0-9a-f]{64}\.jpg$/),
  tMs: z.number().finite(),
  offsetSec: z.number().finite().nonnegative(),
  source: z.literal("probe"),
  phash: z.literal(""),
  reason: z.string().optional(),
})).max(IMPORT_LIMITS.frames);

export class ImportedFrames {
  private readonly controller = new AbortController();
  private frames: FrameRecord[];

  constructor(
    private readonly dir: string,
    private readonly imported: ImportMetadata,
    private readonly anchor: number,
  ) {
    const manifest = path.join(dir, "frames", "frames.json");
    this.frames = existsSync(manifest)
      ? RecordsSchema.parse(JSON.parse(readFileSync(manifest, "utf8")))
        .filter((record) => existsSync(path.join(dir, "frames", record.file)))
      : [];
  }

  get manifest(): readonly FrameRecord[] {
    return [...this.frames].sort((a, b) => a.tMs - b.tMs);
  }

  async extractWindow(request: WindowRequest): Promise<FrameRecord[]> {
    const start = request.startMs - this.anchor;
    const end = request.endMs - this.anchor;
    if (![start, end].every(Number.isFinite) || start < 0 || end < start || start >= this.imported.durationMs) {
      throw new Error("Requested frames are outside the imported recording.");
    }
    const span = Math.min(end, this.imported.durationMs - 1) - start;
    const fps = request.fps ?? 1;
    const cap = request.maxFrames ?? 6;
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(cap) || cap < 1 || cap > 24) {
      throw new Error("Invalid imported-frame sampling request.");
    }
    const count = Math.min(cap, Math.max(1, Math.floor(span * fps / 1000) + 1));
    const offsets = importSampleOffsets(Math.max(1, span + 100), count).map((offset) => start + offset);
    const framesDir = path.join(this.dir, "frames");
    await mkdir(framesDir, { recursive: true });
    const media = new ImportMedia(this.controller.signal);
    const added: FrameRecord[] = [];
    try {
      await media.open(path.join(this.dir, this.imported.file), this.imported.hasAudio, false);
      for (const offset of offsets) {
        this.controller.signal.throwIfAborted();
        const key = createHash("sha256").update(JSON.stringify([Math.round(offset), request.crop ?? null])).digest("hex");
        const file = `import_${key}.jpg`;
        const existing = this.frames.find((item) => item.file === file);
        if (existing) { added.push(existing); continue; }
        if (this.frames.length >= IMPORT_LIMITS.frames) {
          throw new Error("The imported recording's frame budget is exhausted. Narrow the task in Additional details and analyze again.");
        }
        const frame = await media.frame(offset, request.crop);
        this.controller.signal.throwIfAborted();
        await writeFile(path.join(framesDir, file), frame.data);
        const record: FrameRecord = {
          file, tMs: this.anchor + frame.offsetMs, offsetSec: frame.offsetMs / 1000,
          source: "probe", phash: "", reason: request.reason ?? "import:sample",
        };
        this.frames.push(record);
        added.push(record);
      }
      await writeImportJson(framesDir, "frames.json", this.frames);
      return added;
    } finally { media.dispose(); }
  }

  dispose(): void { this.controller.abort(); }
}
