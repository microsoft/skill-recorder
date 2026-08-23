import { existsSync } from "node:fs";
import { chmod, copyFile, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { excludedWasmPackages, sha256File, verifyComplianceDirectory } from "./compliance.mjs";

const require = createRequire(import.meta.url);
const { listPackage } = require("@electron/asar");

async function listUnpackedFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  async function visit(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), next);
      else if (entry.isFile()) files.push(next);
    }
  }
  await visit(root, "");
  return files;
}

async function ensureNodePtyHelpersAreExecutable(resources, platform) {
  if (platform === "win32") return;
  const nodePtyRoot = path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  for (const file of await listUnpackedFiles(nodePtyRoot)) {
    if (path.basename(file) === "spawn-helper") {
      await chmod(path.join(nodePtyRoot, file), 0o755);
    }
  }
}

export default async function verifyPackagedCompliance(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  const resources =
    platform === "darwin"
      ? path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");

  await ensureNodePtyHelpersAreExecutable(resources, platform);

  const compliance = path.join(resources, "compliance");
  const electronNotices = path.join(compliance, "electron");
  const noticeManifest = JSON.parse(
    await readFile(path.join(compliance, "ELECTRON-NOTICES.json"), "utf8"),
  );
  for (const notice of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
    const source = [path.join(context.appOutDir, notice), path.join(resources, notice)].find(
      existsSync,
    );
    const target = path.join(electronNotices, notice);
    const expected = noticeManifest.notices.find(
      ({ file }) => file === `electron/${notice}`,
    )?.sha256;
    if (!expected) throw new Error(`Compliance manifest is missing Electron notice ${notice}.`);
    if (source) {
      const sourceHash = await sha256File(source);
      if (sourceHash !== expected) {
        throw new Error(`Packaged Electron notice ${notice} differs from the reviewed archive.`);
      }
      await copyFile(source, target);
    }
    if (!existsSync(target) || (await sha256File(target)) !== expected) {
      throw new Error(`Packaged application is missing verified Electron notice ${notice}.`);
    }
  }
  await verifyComplianceDirectory(compliance, {
    requireSources: true,
    requireElectronNotices: true,
  });

  const asarPath = path.join(resources, "app.asar");
  if (!existsSync(asarPath)) throw new Error(`Packaged application is missing ${asarPath}.`);

  const entries = listPackage(asarPath).map((entry) =>
    entry.replace(/^[\\/]+/, "").replaceAll("\\", "/").toLowerCase(),
  );
  for (const required of ["license", "third-party-notices.md"]) {
    if (!entries.includes(required)) {
      throw new Error(`Packaged ASAR is missing ${required}.`);
    }
  }

  const nestedOutput = entries.find(
    (entry) =>
      entry.startsWith("release/") ||
      /^dist\/(?:win(?:-[^/]+)?-unpacked|mac(?:-[^/]+)?|linux(?:-[^/]+)?-unpacked)\//.test(
        entry,
      ),
  );
  if (nestedOutput) {
    throw new Error(`Packaged ASAR recursively contains build output: ${nestedOutput}.`);
  }

  // `node_modules/@img/**` is unpacked from the ASAR, so the unused WebAssembly payload
  // must be checked on disk as well as inside the archive.
  const unpackedEntries = (
    await listUnpackedFiles(path.join(resources, "app.asar.unpacked"))
  ).map((entry) => entry.toLowerCase());
  const allEntries = [...entries, ...unpackedEntries];
  for (const name of excludedWasmPackages) {
    const prefix = `node_modules/${name.toLowerCase()}/`;
    const leaked = allEntries.find((entry) => entry.startsWith(prefix));
    if (leaked) {
      throw new Error(
        `Packaged application contains excluded WebAssembly payload ${leaked}; it would ship ` +
          "without corresponding source and notices.",
      );
    }
  }
  const wasmBinary = allEntries.find(
    (entry) => entry.startsWith("node_modules/@img/") && entry.endsWith(".wasm"),
  );
  if (wasmBinary) {
    throw new Error(
      `Packaged application contains an unreviewed Sharp WebAssembly binary: ${wasmBinary}.`,
    );
  }

  console.log(
    `Verified packaged compliance materials and non-recursive ASAR in ${context.appOutDir}.`,
  );
}
