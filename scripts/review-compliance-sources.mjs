#!/usr/bin/env node
/**
 * Proposes SHA-256 values for newly reviewed compliance materials.
 *
 * The release path never bootstraps trust: `compliance:prepare` accepts only
 * hashes already committed to the policy. This separate reviewer utility
 * retrieves the exact pinned inputs and prints policy entries for inspection;
 * it never edits the policy.
 *
 * Usage:
 *   node scripts/review-compliance-sources.mjs [--platform win32|darwin|linux]
 *                                              [--versions <versions.json>]
 *                                              [--all]
 */
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildComplianceSourceSpecs,
  buildStaticRemoteMaterialSpecs,
  deterministicGitConfigArgs,
  hasExpectedFileHeader,
  sha256File,
} from "./compliance.mjs";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewDir = path.join(rootDir, ".compliance-cache", "review");
const reviewGitDir = path.join(reviewDir, "git");

function parseArguments(argv) {
  const options = { all: false, platform: process.platform, versions: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") options.all = true;
    else if (argument === "--platform") options.platform = argv[(index += 1)];
    else if (argument === "--versions") options.versions = argv[(index += 1)];
    else throw new Error(`Unknown argument ${argument}.`);
  }
  if (!options.platform) throw new Error("--platform requires a value.");
  return options;
}

function loadNativeVersions(lock, versionsFile) {
  if (versionsFile) return JSON.parse(readFileSync(path.resolve(versionsFile), "utf8"));
  const candidates = Object.keys(lock.packages ?? {})
    .filter((lockPath) => /^node_modules\/@img\/sharp-/.test(lockPath))
    .map((lockPath) => path.join(rootDir, ...lockPath.split("/"), "versions.json"))
    .filter(existsSync);
  if (candidates.length === 0) {
    throw new Error("No installed Sharp payload exposes versions.json; run npm ci first.");
  }
  const versions = candidates.map((file) => JSON.parse(readFileSync(file, "utf8")));
  const canonical = JSON.stringify(versions[0]);
  if (versions.some((value) => JSON.stringify(value) !== canonical)) {
    throw new Error("Installed Sharp payloads disagree about embedded component versions.");
  }
  return versions[0];
}

function hasReviewedHash(hashes, id) {
  return /^[a-f0-9]{64}$/.test(hashes?.[id] ?? "");
}

async function download(url, target) {
  const temporary = `${target}.partial`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await rm(temporary, { force: true });
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          accept: "application/octet-stream, text/plain;q=0.9, */*;q=0.8",
          "user-agent":
            "Mozilla/5.0 (compatible; SkillRecorderCompliance/1.0; " +
            "+https://github.com/microsoft/skill-recorder)",
        },
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      if (statSync(temporary).size < 100) throw new Error("response was unexpectedly short");
      await rename(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError?.message ?? "unknown error"}`);
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitArchive(spec, target) {
  const safeId = spec.id.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const repository = path.join(reviewGitDir, `${safeId}-${process.pid}`);
  await rm(repository, { recursive: true, force: true });
  await mkdir(repository, { recursive: true });
  try {
    await runGit(["init", "--quiet"], repository);
    await runGit(
      ["fetch", "--depth=1", "--no-tags", "--quiet", spec.gitRepository, spec.gitRevision],
      repository,
    );
    const resolved = await runGit(["rev-parse", "FETCH_HEAD"], repository);
    if (resolved !== spec.gitRevision) {
      throw new Error(`Fetched ${spec.id} revision ${resolved}; expected ${spec.gitRevision}.`);
    }
    await runGit(
      [
        ...deterministicGitConfigArgs,
        "archive",
        "--format=tar",
        `--prefix=${spec.archivePrefix}`,
        `--output=${target}`,
        "FETCH_HEAD",
      ],
      repository,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function reviewSources(specs, policy, all) {
  const pending = specs.filter(({ id }) => all || !hasReviewedHash(policy.sourceMaterials, id));
  return mapLimit(pending, 4, async (spec) => {
    const target = path.join(reviewDir, "sources", spec.fileName);
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { force: true });
    if (spec.gitRepository) await gitArchive(spec, target);
    else await download(spec.url, target);
    if (!(await hasExpectedFileHeader(spec.fileName, target))) {
      throw new Error(`${spec.id} did not produce a valid source archive.`);
    }
    return { id: spec.id, sha256: await sha256File(target), url: spec.url };
  });
}

async function reviewRemoteMaterials(specs, policy, all) {
  const pending = specs.filter(({ id }) => all || !hasReviewedHash(policy.remoteMaterials, id));
  return mapLimit(pending, 4, async (spec) => {
    const target = path.join(reviewDir, "remote", spec.fileName);
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { force: true });
    await download(spec.url, target);
    const content = readFileSync(target, "utf8");
    if (!content.includes(spec.marker)) {
      throw new Error(`${spec.id} does not contain expected marker "${spec.marker}".`);
    }
    return { id: spec.id, sha256: await sha256File(target), url: spec.url };
  });
}

function printEntries(label, results) {
  console.log(`\nProposed third_party/compliance-policy.json ${label} entries:\n`);
  if (results.length === 0) {
    console.log("    (none)");
    return;
  }
  console.log(
    results
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, sha256 }) => `    ${JSON.stringify(id)}: ${JSON.stringify(sha256)}`)
      .join(",\n"),
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const policy = JSON.parse(
    readFileSync(path.join(rootDir, "third_party", "compliance-policy.json"), "utf8"),
  );
  const lock = JSON.parse(readFileSync(path.join(rootDir, "package-lock.json"), "utf8"));
  const nativeVersions = loadNativeVersions(lock, options.versions);
  const sourceSpecs = buildComplianceSourceSpecs(
    nativeVersions,
    lock,
    policy,
    options.platform,
  );
  const [sources, remote] = await Promise.all([
    reviewSources(sourceSpecs, policy, options.all),
    reviewRemoteMaterials(buildStaticRemoteMaterialSpecs(policy), policy, options.all),
  ]);
  printEntries("sourceMaterials", sources);
  printEntries("remoteMaterials", remote);
}

await main();
