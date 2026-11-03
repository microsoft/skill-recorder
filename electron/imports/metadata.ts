import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { IMPORT_FILE, ImportMetadataSchema, type ImportMetadata } from "../../common/import";
import type { SessionMeta } from "../../common/types";

export function readImport(dir: string): ImportMetadata | null {
  const file = path.join(dir, IMPORT_FILE);
  if (!existsSync(file)) return null;
  return ImportMetadataSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function readSessionImport(dir: string): ImportMetadata | null {
  const file = path.join(dir, "session.json");
  if (!existsSync(file)) return null;
  const meta = JSON.parse(readFileSync(file, "utf8")) as SessionMeta;
  if (meta.source !== "imported-video") return null;
  const imported = readImport(dir);
  if (!imported) throw new Error("Imported recording metadata is missing.");
  return imported;
}

export async function writeImportJson(dir: string, name: string, value: unknown): Promise<void> {
  const target = path.join(dir, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
