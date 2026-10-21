// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Skill Recorder contributors

import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMicrosoftSignInHintProbe } from "../common/microsoft-signin-hint.ts";

const microsoftRegistry = "https://packagefeedproxy.microsoft.io/npm/";
export const installArguments = [
  "ci", "--no-audit", "--no-fund", "--ignore-scripts=false",
  "--dangerously-allow-all-scripts=false", "--strict-allow-scripts",
];

function exists(file) {
  try {
    statSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function isUnconfiguredPublicRegistry(config, env, cwd, npmCli, fileExists = exists) {
  if (config.registry !== "https://registry.npmjs.org/") return false;
  // Be conservative: even an explicitly selected public registry must be honored.
  if (Object.keys(env).some((key) => /^npm_config_/i.test(key))) return false;
  if (!config.userconfig || !config.globalconfig) return false;
  if (Object.entries(config).some(([key, value]) =>
    value != null && (/:registry$/i.test(key) || /(?:_auth|_password|username)/i.test(key)),
  )) return false;
  return ![
    config.userconfig, config.globalconfig, path.join(cwd, ".npmrc"),
    path.resolve(path.dirname(npmCli), "..", "npmrc"),
  ].some(fileExists);
}

export function isPublicRegistryAccessFailure(stderr) {
  const codes = [...stderr.matchAll(/^npm (?:error|ERR!) code (\S+)\s*$/gm)].map((match) => match[1]);
  const accessCodes = new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ENOTFOUND",
    "EAI_AGAIN", "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED",
  ]);
  return codes.length === 1 && accessCodes.has(codes[0]) &&
    /^npm (?:error|ERR!) (?:[^\r\n]* )?request to https:\/\/registry\.npmjs\.org\/[^\s]* failed, reason:/m.test(stderr);
}

export async function installWithRecovery({ run, eligible, microsoftHint, env, log }) {
  const first = await run(installArguments, env);
  if (first.code === 0) return;
  const initialFailure = `npm ci failed with exit code ${first.code}.`;
  if (!eligible || !isPublicRegistryAccessFailure(first.stderr) || !await microsoftHint()) {
    throw new Error(`${initialFailure} No automatic registry fallback applies; existing configuration was preserved.`);
  }

  log("Public npm registry access failed on a Microsoft-associated Windows device/account. Retrying once through Microsoft's package registry; no npm settings will be saved.");
  // Change only this child process's environment, never the caller or npmrc files.
  const retryEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_registry$/i.test(key)));
  retryEnv.NPM_CONFIG_REGISTRY = microsoftRegistry;
  const retry = await run(installArguments, retryEnv);
  if (retry.code !== 0) {
    throw new Error(`${initialFailure} Microsoft registry retry also failed with exit code ${retry.code}. See the errors above; complete approved feed/network provisioning before retrying.`);
  }
  log("Dependencies installed through the Microsoft registry. Persistent npm configuration is unchanged.");
}

export function runNpm(npmCli, args, env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      env, windowsHide: true, shell: false,
      stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputLimit = false;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) {
        outputLimit = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!capture) process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (outputLimit) reject(new Error("npm configuration output exceeded its size limit."));
      else if (code === null) reject(new Error("npm was interrupted; registry recovery was not attempted."));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  if (process.platform !== "win32") throw new Error("This dependency installer is Windows-only.");
  const npmCli = process.argv[2];
  if (!npmCli || !path.isAbsolute(npmCli)) throw new Error("An absolute bundled npm CLI path is required.");
  const env = { ...process.env };
  const result = await runNpm(npmCli, ["config", "list", "--json"], env, true);
  if (result.code !== 0) throw new Error("Could not read npm configuration; no registry fallback was attempted.");
  const config = JSON.parse(result.stdout);
  const log = (message) => console.log(`[Skill Recorder] ${message}`);
  const eligible = isUnconfiguredPublicRegistry(config, env, process.cwd(), npmCli);
  const microsoftHint = createMicrosoftSignInHintProbe({
    platform: process.platform,
    systemRoot: env.SystemRoot ?? env.windir,
    execFile,
    log: { info: (message, details) => log(`${message}: ${details.reason}`) },
  });
  await installWithRecovery({
    run: (args, childEnv) => runNpm(npmCli, args, childEnv),
    eligible, microsoftHint, env, log,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[Skill Recorder] ${error.message}`);
    process.exitCode = 1;
  });
}
