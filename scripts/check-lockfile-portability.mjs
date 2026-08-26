#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const canonicalRegistry = "https://registry.npmjs.org/";
const canonicalOrigin = new URL(canonicalRegistry).origin;
const azureArtifactsHost = /(?:^|\.)pkgs\.(?:visualstudio\.com|dev\.azure\.com)$/i;
const microsoftProxyHost = /^packagefeedproxy\.microsoft\.io$/i;
const minimumPolicyNpm = [11, 17, 0];

export function assertPolicyCapableNpm(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version ?? ""));
  if (!match) {
    throw new Error(`Could not parse npm version: ${version}`);
  }
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimumPolicyNpm.length; index += 1) {
    if (actual[index] > minimumPolicyNpm[index]) return;
    if (actual[index] < minimumPolicyNpm[index]) {
      throw new Error(
        `npm ${minimumPolicyNpm.join(".")} or newer is required to enforce allowScripts.`,
      );
    }
  }
}

function packageNameFromResolved(resolved) {
  if (typeof resolved !== "string") return null;
  try {
    const url = new URL(resolved);
    if (url.origin !== canonicalOrigin) return null;
    const match = decodeURIComponent(url.pathname).match(
      /^\/((?:@[^/]+\/)?[^/]+)\/-\//,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function registryPackagePath(url) {
  if (azureArtifactsHost.test(url.hostname)) {
    const marker = "/npm/registry/";
    const index = url.pathname.lastIndexOf(marker);
    return index === -1 ? null : url.pathname.slice(index + marker.length);
  }
  if (microsoftProxyHost.test(url.hostname)) {
    return url.pathname.replace(/^\/npm\//, "");
  }
  return null;
}

export function normalizeLockfileRegistryUrls(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("package-lock.json must declare a packages map.");
  }

  let changed = 0;
  for (const entry of Object.values(packages)) {
    if (typeof entry?.resolved !== "string") continue;

    let url;
    try {
      url = new URL(entry.resolved);
    } catch {
      continue;
    }
    const packagePath = registryPackagePath(url);
    if (!packagePath) continue;

    entry.resolved = `${canonicalRegistry}${packagePath}${url.search}${url.hash}`;
    changed += 1;
  }
  return changed;
}

export function assertPortableLockfileRegistries(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("package-lock.json must declare a packages map.");
  }

  const invalid = [];
  for (const [location, entry] of Object.entries(packages)) {
    if (typeof entry?.resolved !== "string") continue;

    try {
      const url = new URL(entry.resolved);
      if (url.origin !== canonicalOrigin) {
        invalid.push(`${location}: ${entry.resolved}`);
      }
    } catch {
      invalid.push(`${location}: ${entry.resolved}`);
    }
  }

  if (invalid.length > 0) {
    throw new Error(
      "package-lock.json contains non-portable resolved URLs. Registry packages must use " +
        `${canonicalRegistry}. Run \`npm run fix:lockfile-registry\` and review the diff:\n` +
        invalid.slice(0, 10).join("\n"),
    );
  }
}

export function assertReviewedInstallScripts(lock, manifest) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("package-lock.json must declare a packages map.");
  }
  const rules = manifest?.allowScripts;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error("package.json must declare an allowScripts policy.");
  }

  const installScripts = [];
  for (const [location, entry] of Object.entries(packages)) {
    if (entry?.hasInstallScript !== true) continue;
    const name = packageNameFromResolved(entry.resolved);
    if (!name || typeof entry.version !== "string") {
      throw new Error(
        `Cannot determine the registry identity for install-script package ${location}.`,
      );
    }
    installScripts.push({ location, name, version: entry.version });
  }

  const names = new Set(installScripts.map(({ name }) => name));
  const exact = new Set(installScripts.map(({ name, version }) => `${name}@${version}`));
  const invalidRules = [];
  for (const [rule, decision] of Object.entries(rules)) {
    if (typeof decision !== "boolean") {
      invalidRules.push(`${rule} must be true or false`);
    } else if (decision === true && !exact.has(rule)) {
      invalidRules.push(`${rule} must pin an installed package version`);
    } else if (decision === false && !names.has(rule) && !exact.has(rule)) {
      invalidRules.push(`${rule} does not match an install-script package`);
    }
  }

  const uncovered = installScripts.filter(({ name, version }) => {
    const exactDecision = rules[`${name}@${version}`];
    return exactDecision !== true && exactDecision !== false && rules[name] !== false;
  });
  if (invalidRules.length > 0 || uncovered.length > 0) {
    const details = [
      ...invalidRules,
      ...uncovered.map(({ name, version }) => `${name}@${version} has no reviewed decision`),
    ];
    throw new Error(`Dependency install-script policy is incomplete:\n${details.join("\n")}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let fix = false;
  let npmVersion = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--fix" && !fix) {
      fix = true;
    } else if (args[index] === "--npm-version" && args[index + 1] && npmVersion === null) {
      npmVersion = args[index + 1];
      index += 1;
    } else {
      throw new Error(
        "Usage: node scripts/check-lockfile-portability.mjs " +
          "[--fix] [--npm-version <version>]",
      );
    }
  }

  const root = process.cwd();
  const lockPath = path.join(root, "package-lock.json");
  const manifestPath = path.join(root, "package.json");
  const [lock, manifest] = await Promise.all([
    readFile(lockPath, "utf8").then(JSON.parse),
    readFile(manifestPath, "utf8").then(JSON.parse),
  ]);

  if (!npmVersion) {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath) {
      try {
        const npmManifest = JSON.parse(
          await readFile(path.resolve(path.dirname(npmExecPath), "..", "package.json"), "utf8"),
        );
        npmVersion = npmManifest.version ?? null;
      } catch {
        // Fall back to npm's user-agent value below.
      }
    }
    npmVersion ??=
      /\bnpm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? null;
  }
  if (npmVersion) {
    assertPolicyCapableNpm(npmVersion);
  }

  if (fix) {
    const changed = normalizeLockfileRegistryUrls(lock);
    if (changed > 0) {
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }
    console.log(`Normalized ${changed} lockfile registry URL${changed === 1 ? "" : "s"}.`);
  }

  assertPortableLockfileRegistries(lock);
  assertReviewedInstallScripts(lock, manifest);
  console.log("Lockfile registry URLs and dependency install scripts are portable and reviewed.");
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
