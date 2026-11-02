import { z } from "zod";

import { isNarrationLanguage } from "./narration";

export const IMPORT_LIMITS = {
  bytes: 512 * 1024 * 1024,
  durationMs: 15 * 60 * 1000,
  pixels: 3840 * 2160,
  details: 10_000,
  frames: 300,
} as const;
export const IMPORT_LIMIT_LABEL = "MP4 or WebM, up to 512 MiB and 15 minutes";
export const IMPORT_FILE = "import.json";

export const ImportMetadataSchema = z.object({
  version: z.literal(1),
  file: z.enum(["import.mp4", "import.webm"]),
  name: z.string().min(1).max(255),
  importedAt: z.number().finite().positive(),
  bytes: z.number().int().positive().max(IMPORT_LIMITS.bytes),
  durationMs: z.number().positive().max(IMPORT_LIMITS.durationMs),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
  details: z.string().max(IMPORT_LIMITS.details),
  language: z.custom<import("./narration").NarrationLanguage>(isNarrationLanguage),
}).refine((value) => value.width * value.height <= IMPORT_LIMITS.pixels, {
  message: "Recording resolution exceeds the import limit.",
});
export type ImportMetadata = z.infer<typeof ImportMetadataSchema>;

export const ImportDetailsSchema = z.object({
  details: z.string().max(IMPORT_LIMITS.details),
  language: z.custom<import("./narration").NarrationLanguage>(isNarrationLanguage),
});
export type ImportDetails = z.infer<typeof ImportDetailsSchema>;
export interface ImportResult {
  ok: boolean;
  sessionId?: string;
  canceled?: boolean;
  error?: string;
}

export function importSampleOffsets(durationMs: number, count: number): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isInteger(count) || count < 1) {
    throw new Error("Invalid recording sample request.");
  }
  const end = Math.max(0, durationMs - 100);
  return Array.from({ length: count }, (_, index) =>
    Math.round(count === 1 ? 0 : (end * index) / (count - 1)),
  );
}
