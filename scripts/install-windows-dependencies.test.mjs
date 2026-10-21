// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Skill Recorder contributors

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  installArguments, installWithRecovery, isPublicRegistryAccessFailure,
  isUnconfiguredPublicRegistry, runNpm,
} from "./install-windows-dependencies.mjs";
import { parseMicrosoftSignInHint } from "../common/microsoft-signin-hint.ts";

const accessFailure = (code = "ECONNRESET", host = "registry.npmjs.org") =>
  `npm error code ${code}\nnpm error request to https://${host}/zod/-/zod-4.4.3.tgz failed, reason: connection terminated\n`;
const config = {
  registry: "https://registry.npmjs.org/", userconfig: "user-npmrc",
  globalconfig: "global-npmrc", _auth: null,
};
const cwd = path.resolve("fixture");
const npmCli = path.join(cwd, "runtime", "node_modules", "npm", "bin", "npm-cli.js");

test("only an unconfigured public registry is eligible", () => {
  const eligible = (overrides = {}, env = {}, exists = () => false) =>
    isUnconfiguredPublicRegistry({ ...config, ...overrides }, env, cwd, npmCli, exists);
  assert.equal(eligible(), true);
  for (const registry of ["https://example.invalid/", "http://registry.npmjs.org/", "https://registry.npmjs.org.evil.invalid/"]) {
    assert.equal(eligible({ registry }), false);
  }
  for (const name of ["NPM_CONFIG_REGISTRY", "npm_config_registry", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_PREFIX", "npm_config_@github:registry"]) {
    assert.equal(eligible({}, { [name]: "explicit" }), false);
  }
  for (const file of [
    config.userconfig, config.globalconfig, path.join(cwd, ".npmrc"),
    path.resolve(path.dirname(npmCli), "..", "npmrc"),
  ]) {
    assert.equal(eligible({}, {}, (candidate) => candidate === file), false, file);
  }
  assert.equal(eligible({ userconfig: null }), false);
  assert.equal(eligible({ globalconfig: null }), false);
  assert.equal(eligible({ "@github:registry": "https://example.invalid/" }), false);
  assert.equal(eligible({ "//registry.npmjs.org/:_authToken": "secret" }), false);
  assert.throws(() => eligible({}, {}, () => { throw new Error("Access denied"); }), /Access denied/);
});

test("registry-access classification excludes package, build, permissions, and integrity failures", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE", "SELF_SIGNED_CERT_IN_CHAIN"]) {
    assert.equal(isPublicRegistryAccessFailure(accessFailure(code)), true, code);
  }
  assert.equal(isPublicRegistryAccessFailure(accessFailure().replaceAll("npm error", "npm ERR!").replaceAll("\n", "\r\n")), true);
  for (const code of ["EINTEGRITY", "EPERM", "EACCES", "E404", "E401", "E403", "ETARGET", "1"]) {
    assert.equal(isPublicRegistryAccessFailure(accessFailure(code)), false, code);
  }
  assert.equal(isPublicRegistryAccessFailure(accessFailure("ECONNRESET", "example.invalid")), false);
  assert.equal(isPublicRegistryAccessFailure(accessFailure("ECONNRESET", "registry.npmjs.org.evil.invalid")), false);
  assert.equal(isPublicRegistryAccessFailure("ECONNRESET while building"), false);
  assert.equal(isPublicRegistryAccessFailure(accessFailure() + "npm error code EINTEGRITY\n"), false);
});

function harness({ first = { code: 1, stderr: accessFailure() }, retry = { code: 0, stderr: "" }, eligible = true, hint = true } = {}) {
  const calls = [];
  const messages = [];
  const env = Object.freeze({ PATH: "original", EXAMPLE: "preserved" });
  let hintCalls = 0;
  return {
    calls, messages, env, hints: () => hintCalls,
    execute: () => installWithRecovery({
      run: async (args, childEnv) => {
        calls.push({ args, env: childEnv });
        return calls.length === 1 ? first : retry;
      },
      eligible, env, microsoftHint: async () => { hintCalls++; return hint; },
      log: (message) => messages.push(message),
    }),
  };
}

test("public success never probes the tenant or switches registries", async () => {
  const h = harness({ first: { code: 0, stderr: "" } });
  await h.execute();
  assert.equal(h.calls.length, 1);
  assert.equal(h.hints(), 0);
  assert.equal(h.messages.length, 0);
});

test("Microsoft access failure retries exactly once with identical policy flags and a child-only override", async () => {
  const h = harness();
  await h.execute();
  assert.equal(h.calls.length, 2);
  assert.equal(h.hints(), 1);
  for (const call of h.calls) assert.deepEqual(call.args, installArguments);
  assert.equal(h.calls[0].env, h.env);
  assert.notEqual(h.calls[1].env, h.env);
  assert.equal(h.calls[1].env.PATH, h.env.PATH);
  assert.equal(h.calls[1].env.EXAMPLE, "preserved");
  assert.equal(h.calls[1].env.NPM_CONFIG_REGISTRY, "https://packagefeedproxy.microsoft.io/npm/");
  assert.equal(h.env.NPM_CONFIG_REGISTRY, undefined);
  assert.match(h.messages[0], /Retrying once/);
  assert.match(h.messages[1], /installed/);
});

test("Windows command-line entry point reads config and executes the supplied bundled npm", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "installer-entry-"));
  try {
    const cli = path.join(root, "npm fixture.cjs");
    await writeFile(cli, `
      const assert = require("node:assert/strict");
      if (process.argv[2] === "config") {
        console.log(JSON.stringify({
          registry: "https://example.invalid/",
          userconfig: ${JSON.stringify(path.join(root, "user-npmrc"))},
          globalconfig: ${JSON.stringify(path.join(root, "global-npmrc"))}
        }));
      } else {
        assert.deepEqual(process.argv.slice(2), ${JSON.stringify(installArguments)});
        console.log("fixture installation complete");
      }
    `);
    const entry = fileURLToPath(new URL("./install-windows-dependencies.mjs", import.meta.url));
    const result = await runNpm(entry, [cli], { ...process.env }, true);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /fixture installation complete/);

    await writeFile(cli, 'console.error("configuration failure"); process.exitCode = 1;');
    const failed = await runNpm(entry, [cli], { ...process.env }, true);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Could not read npm configuration; no registry fallback was attempted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Microsoft, configured, and non-network failures never retry", async () => {
  for (const options of [
    { hint: false }, { eligible: false },
    { first: { code: 1, stderr: accessFailure("EINTEGRITY") } },
  ]) {
    const h = harness(options);
    await assert.rejects(h.execute(), /No automatic registry fallback applies/);
    assert.equal(h.calls.length, 1);
    if (options.hint !== false) assert.equal(h.hints(), 0);
  }
});

test("failed fallback reports both attempts without another retry or environment mutation", async () => {
  const h = harness({ retry: { code: 42, stderr: "npm error code E403\n" } });
  await assert.rejects(h.execute(), /exit code 1.*retry also failed with exit code 42/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.env.NPM_CONFIG_REGISTRY, undefined);
  assert.equal(h.messages.length, 1);
});

test("installer uses the same joined/registered Microsoft tenant parser as app sign-in", () => {
  const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  assert.equal(parseMicrosoftSignInHint(`| Device State |\nAzureAdJoined : YES\n| Tenant Details |\nTenantId : ${tenant}`), true);
  assert.equal(parseMicrosoftSignInHint(`| User State |\nWorkplaceJoined : YES\n| Work Account 1 |\nWorkplaceTenantId : ${tenant}`), true);
  assert.equal(parseMicrosoftSignInHint("| Device State |\nAzureAdJoined : YES\n| Tenant Details |\nTenantId : another-company"), false);
  assert.equal(parseMicrosoftSignInHint(`| Tenant Details |\nTenantId : ${tenant}`), false);
});

test("real child-process execution captures npm errors and applies the override only on retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "installer-npm-"));
  try {
    const cli = path.join(root, "fake-npm.cjs");
    await writeFile(cli, `
      const assert = require("node:assert/strict");
      const args = process.argv.slice(2);
      if (args[0] === "config") {
        console.log(JSON.stringify({ registry: "https://registry.npmjs.org/" }));
      } else {
        assert.deepEqual(args, ${JSON.stringify(installArguments)});
        if (!process.env.NPM_CONFIG_REGISTRY) {
          console.error(${JSON.stringify(accessFailure())});
          process.exitCode = 1;
        } else {
          assert.equal(process.env.NPM_CONFIG_STRICT_SSL, undefined);
        }
      }
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    const result = await runNpm(cli, ["config", "list", "--json"], env, true);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).registry, config.registry);
    let attempts = 0;
    await installWithRecovery({
      run: (args, childEnv) => { attempts++; return runNpm(cli, args, childEnv); },
      eligible: true, env, microsoftHint: async () => true, log: () => {},
    });
    assert.equal(attempts, 2);
    assert.equal(env.NPM_CONFIG_REGISTRY, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
