#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { sanitizeElectronEnvironment } from "./run-reviewed-electron.mjs";

const require = createRequire(import.meta.url);
const { extract } = require("@electron-internal/extract-zip");
const officialElectronReleases =
  "https://github.com/electron/electron/releases/download/";
const reviewedMetadataName = ".skill-recorder-reviewed.json";

function parseArguments(args) {
  const options = {
    archive: null,
    platform: process.platform,
    arch: process.arch,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!["--archive", "--platform", "--arch"].includes(argument) || !args[index + 1]) {
      throw new Error(
        "Usage: node scripts/install-reviewed-electron.mjs " +
          "[--archive <zip>] [--platform <platform>] [--arch <architecture>]",
      );
    }
    options[argument.slice(2)] = args[index + 1];
    index += 1;
  }
  return options;
}

function platformExecutable(platform) {
  switch (platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron is not reviewed for platform ${platform}.`);
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function withSanitizedElectronEnvironment(callback) {
  const sanitized = sanitizeElectronEnvironment(process.env);
  const removed = [];
  for (const key of Object.keys(process.env)) {
    if (!(key in sanitized)) {
      removed.push([key, process.env[key]]);
      delete process.env[key];
    }
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of removed) {
      process.env[key] = value;
    }
  }
}

async function installArchive(archive, electronDirectory, platformPath, version) {
  const distDirectory = path.join(electronDirectory, "dist");
  await rm(path.join(electronDirectory, reviewedMetadataName), { force: true });
  await rm(distDirectory, { recursive: true, force: true });
  await mkdir(distDirectory, { recursive: true });
  await extract(archive, { dir: distDirectory });

  const bundledTypes = path.join(distDirectory, "electron.d.ts");
  if (existsSync(bundledTypes)) {
    const packageTypes = path.join(electronDirectory, "electron.d.ts");
    await rm(packageTypes, { force: true });
    await rename(bundledTypes, packageTypes);
  }
  await writeFile(path.join(electronDirectory, "path.txt"), platformPath);

  const installedVersion = (
    await readFile(path.join(distDirectory, "version"), "utf8")
  ).trim().replace(/^v/, "");
  if (installedVersion !== version) {
    throw new Error(
      `Electron runtime version mismatch. Expected ${version}, got ${installedVersion}.`,
    );
  }
  const executable = path.join(distDirectory, platformPath);
  await access(executable);
  return sha256File(executable);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = process.cwd();
  const electronDirectory = path.join(root, "node_modules", "electron");
  const [electronPackage, checksums, policy] = await Promise.all([
    readFile(path.join(electronDirectory, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(electronDirectory, "checksums.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "third_party", "compliance-policy.json"), "utf8").then(JSON.parse),
  ]);

  if (electronPackage.version !== policy.electron?.version) {
    throw new Error("Installed Electron version has not been reviewed by the compliance policy.");
  }
  const distributionKey = `${options.platform}-${options.arch}`;
  const archiveName =
    `electron-v${electronPackage.version}-${options.platform}-${options.arch}.zip`;
  const expectedHash = policy.electron.distributions?.[distributionKey];
  if (!/^[0-9a-f]{64}$/i.test(expectedHash ?? "")) {
    throw new Error(`No reviewed Electron distribution exists for ${distributionKey}.`);
  }
  if (String(checksums[archiveName] ?? "").toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error("Electron's bundled checksum does not match the reviewed distribution hash.");
  }

  let archive = options.archive && path.resolve(options.archive);
  if (!archive) {
    archive = await withSanitizedElectronEnvironment(async () => {
      const { downloadArtifact, initializeProxy } = require("@electron/get");
      initializeProxy();
      return downloadArtifact({
        version: electronPackage.version,
        artifactName: "electron",
        platform: options.platform,
        arch: options.arch,
        checksums,
        mirrorOptions: {
          mirror: officialElectronReleases,
          customDir: `v${electronPackage.version}`,
          customFilename: archiveName,
        },
      });
    });
  }

  const actualHash = await sha256File(archive);
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(
      `Electron archive SHA-256 mismatch. Expected ${expectedHash}, got ${actualHash}.`,
    );
  }
  const executableSha256 = await installArchive(
    archive,
    electronDirectory,
    platformExecutable(options.platform),
    electronPackage.version,
  );
  const metadataPath = path.join(electronDirectory, reviewedMetadataName);
  const temporaryMetadataPath = `${metadataPath}.${process.pid}.tmp`;
  await writeFile(
    temporaryMetadataPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: electronPackage.version,
        platform: options.platform,
        arch: options.arch,
        archiveSha256: actualHash,
        executable: platformExecutable(options.platform),
        executableSha256,
      },
      null,
      2,
    )}\n`,
  );
  await rename(temporaryMetadataPath, metadataPath);

  console.log(`Installed reviewed Electron ${electronPackage.version} for ${distributionKey}.`);
}

await main();
