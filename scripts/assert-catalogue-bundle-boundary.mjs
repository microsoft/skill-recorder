import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATALOGUE_HEADING = /^# Target:[^\r\n]+/gm;
const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs"]);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cataloguesDirectory = path.join(
  rootDir,
  "electron",
  "architectures",
  "catalogues",
);

async function catalogueMarkers() {
  const entries = (await readdir(cataloguesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith("-catalogue.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const markers = [];

  for (const entry of entries) {
    const source = await readFile(
      path.join(cataloguesDirectory, entry.name),
      "utf8",
    );
    const headings = source.match(CATALOGUE_HEADING) ?? [];
    if (headings.length === 0) {
      throw new Error(
        `${entry.name} must contain at least one "# Target:" catalogue heading.`,
      );
    }
    markers.push(...headings.map((heading) => [entry.name, heading]));
  }

  if (markers.length === 0) {
    throw new Error("No architecture catalogue markers were found.");
  }
  return markers;
}

async function containsMarker(directory, marker) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsMarker(entryPath, marker)) return true;
      continue;
    }
    if (
      TEXT_EXTENSIONS.has(path.extname(entry.name)) &&
      (await readFile(entryPath, "utf8")).includes(marker)
    ) {
      return true;
    }
  }
  return false;
}

for (const [name, marker] of await catalogueMarkers()) {
  if (await containsMarker(path.join(rootDir, "dist"), marker)) {
    throw new Error(`${name} catalogue content leaked into the renderer bundle.`);
  }
  if (!(await containsMarker(path.join(rootDir, "dist-electron"), marker))) {
    throw new Error(`${name} catalogue content is missing from the Electron bundle.`);
  }
}

console.log("Catalogue bundle boundary verified.");
