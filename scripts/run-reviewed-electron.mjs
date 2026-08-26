#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reviewedMetadataName = ".skill-recorder-reviewed.json";
const dangerousElectronEnvironment = new Set([
  "electron_config_cache",
  "electron_custom_dir",
  "electron_customdir",
  "electron_custom_filename",
  "electron_customfilename",
  "electron_custom_version",
  "electron_customversion",
  "electron_mirror",
  "electron_nightly_mirror",
  "electron_nightlymirror",
  "electron_override_dist_path",
  "electron_run_as_node",
  "electron_skip_binary_download",
  "electron_use_remote_checksums",
  "force_no_cache",
]);

export function sanitizeElectronEnvironment(environment) {
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalized = key
      .toLowerCase()
      .replace(/^npm_(?:config|package_config)_/, "");
    if (!dangerousElectronEnvironment.has(normalized)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function assertReviewedPackagePath(reviewedPath, packagePath) {
  if (packagePath !== reviewedPath) {
    throw new Error(
      "Electron's package path does not match the reviewed runtime. " +
        "Run `npm run electron:install-reviewed`.",
    );
  }
}

export function exitCodeForSignal(signal) {
  return 128 + (osConstants.signals[signal] ?? 1);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function verifyReviewedRuntime(root) {
  const electronDirectory = path.join(root, "node_modules", "electron");
  const [metadata, electronPackage, checksums, policy, packagePath] = await Promise.all([
    readFile(path.join(electronDirectory, reviewedMetadataName), "utf8").then(JSON.parse),
    readFile(path.join(electronDirectory, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(electronDirectory, "checksums.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "third_party", "compliance-policy.json"), "utf8").then(JSON.parse),
    readFile(path.join(electronDirectory, "path.txt"), "utf8"),
  ]);

  const distributionKey = `${metadata.platform}-${metadata.arch}`;
  const archiveName =
    `electron-v${metadata.version}-${metadata.platform}-${metadata.arch}.zip`;
  const reviewedArchiveHash = policy.electron?.distributions?.[distributionKey];
  if (
    metadata.schemaVersion !== 1 ||
    metadata.version !== electronPackage.version ||
    metadata.version !== policy.electron?.version ||
    metadata.archiveSha256 !== reviewedArchiveHash ||
    checksums[archiveName] !== reviewedArchiveHash
  ) {
    throw new Error(
      "Electron review metadata is invalid. Run `npm run electron:install-reviewed`.",
    );
  }

  const executable = path.resolve(electronDirectory, "dist", metadata.executable);
  const distDirectory = `${path.resolve(electronDirectory, "dist")}${path.sep}`;
  if (!executable.startsWith(distDirectory)) {
    throw new Error("Reviewed Electron executable escapes its distribution directory.");
  }
  assertReviewedPackagePath(metadata.executable, packagePath);
  const executableHash = await sha256File(executable);
  if (executableHash !== metadata.executableSha256) {
    throw new Error(
      "The reviewed Electron executable has changed. Run `npm run electron:install-reviewed`.",
    );
  }
  return executable;
}

async function run(command, args, root) {
  const child = spawn(command, args, {
    cwd: root,
    env: sanitizeElectronEnvironment(process.env),
    stdio: "inherit",
    windowsHide: false,
  });
  const signals =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGBREAK"]
      : ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR2"];
  let forwardedSignal = null;
  let forceKillTimer = null;
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      if (forwardedSignal) {
        child.kill("SIGKILL");
        return;
      }
      forwardedSignal = signal;
      child.kill(signal);
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      forceKillTimer.unref();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (forwardedSignal) {
        resolve(exitCodeForSignal(forwardedSignal));
      } else if (signal) {
        reject(new Error(`Reviewed Electron command exited from signal ${signal}.`));
      } else {
        resolve(exitCode ?? 1);
      }
    });
  }).finally(() => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  });
  process.exitCode = code;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!["dev", "start"].includes(mode)) {
    throw new Error("Usage: node scripts/run-reviewed-electron.mjs <dev|start> [arguments...]");
  }

  const root = process.cwd();
  const executable = await verifyReviewedRuntime(root);
  if (mode === "start") {
    await run(executable, [root, ...args], root);
  } else {
    await run(
      process.execPath,
      [path.join(root, "node_modules", "vite", "bin", "vite.js"), ...args],
      root,
    );
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
