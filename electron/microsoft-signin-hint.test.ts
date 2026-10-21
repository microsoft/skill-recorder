import assert from "node:assert/strict";
import test from "node:test";
import {
  createMicrosoftSignInHintProbe,
  parseMicrosoftSignInHint,
  type MicrosoftSignInHintDependencies,
} from "./microsoft-signin-hint";

const microsoft = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const other = "11111111-2222-3333-4444-555555555555";
const section = (name: string, fields: string) =>
  `+----------------------------------------------------------------------+\n| ${name.padEnd(69)}|\n+----------------------------------------------------------------------+\n${fields}\n`;
const joined = (tenant = microsoft, state = "YES") =>
  section("Device State", ` AzureAdJoined : ${state}\n DomainJoined : YES`) +
  section("Tenant Details", ` TenantId : ${tenant}`);
const registered = (tenant = microsoft, state = "YES") =>
  section("Device State", " AzureAdJoined : NO") +
  section("User State", ` WorkplaceJoined : ${state}`) +
  section("Work Account 1", ` WorkplaceTenantId : ${tenant}`);

test("matches the exact Microsoft joined tenant, including uppercase GUID and CRLF", () => {
  assert.equal(parseMicrosoftSignInHint(joined()), true);
  assert.equal(parseMicrosoftSignInHint(joined(microsoft.toUpperCase()).replaceAll("\n", "\r\n")), true);
});

test("rejects other tenants, tenant substrings, and unjoined/domain-only devices", () => {
  for (const output of [
    joined(other), joined(`${microsoft}-extra`), joined(`prefix-${microsoft}`),
    joined(microsoft, "NO"), joined(microsoft, "UNKNOWN"), joined(microsoft, "YES extra"),
    section("Device State", "DomainJoined : YES") + section("Tenant Details", `TenantId : ${microsoft}`),
  ]) assert.equal(parseMicrosoftSignInHint(output), false);
});

test("matches registered accounts only with user registration state", () => {
  assert.equal(parseMicrosoftSignInHint(registered()), true);
  assert.equal(parseMicrosoftSignInHint(registered(other)), false);
  assert.equal(parseMicrosoftSignInHint(registered(microsoft, "NO")), false);
  assert.equal(parseMicrosoftSignInHint(registered(other) +
    section("Work Account 2", `WorkplaceTenantId : ${microsoft}`)), true);
});

test("does not confuse joined and registered tenant fields or unrelated output", () => {
  for (const output of [
    registered().replace("WorkplaceTenantId", "TenantId"),
    joined().replace("TenantId", "WorkplaceTenantId"),
    joined(other) + registered(microsoft, "NO"),
    joined(microsoft, "NO") + registered(other),
    joined(other) + section("Diagnostic Data", `TenantId : ${microsoft}`),
    registered(other) + section("Diagnostic Data", `WorkplaceTenantId : ${microsoft}`),
    joined(other) + `\n TenantName : Microsoft\n User Identity : person@microsoft.com\n URL : https://example.com/${microsoft}`,
  ]) assert.equal(parseMicrosoftSignInHint(output), false);
});

test("malformed, missing, duplicate, localized and oversized output fails closed", () => {
  for (const output of [
    "", "not dsregcmd output", `AzureAdJoined : YES\nTenantId : ${microsoft}`,
    section("Tenant Details", `TenantId : ${microsoft}`),
    joined(""), joined(`{${microsoft}}`), joined().replace("TenantId :", "TenantId ="),
    joined() + "\nTenantId : " + other,
    joined() + section("Tenant Details", `TenantId : ${other}`),
    joined().replace("Device State", "Gerätestatus"),
    joined() + "x".repeat(128 * 1024),
  ]) assert.equal(parseMicrosoftSignInHint(output), false);
});

function harness(overrides: Partial<MicrosoftSignInHintDependencies> = {}) {
  const logs: unknown[][] = [];
  let calls = 0;
  const deps: MicrosoftSignInHintDependencies = {
    platform: "win32",
    systemRoot: "C:\\Windows",
    log: { info: (...args) => { logs.push(args); } },
    execFile: (file, args, options, callback) => {
      calls++;
      assert.equal(file, "C:\\Windows\\System32\\dsregcmd.exe");
      assert.deepEqual(args, ["/status"]);
      assert.deepEqual(options, {
        encoding: "utf8", timeout: 3_000, maxBuffer: 128 * 1024,
        windowsHide: true, shell: false,
      });
      queueMicrotask(() => callback(null, joined(), ""));
    },
    ...overrides,
  };
  return { probe: createMicrosoftSignInHintProbe(deps), logs, calls: () => calls };
}

test("probe executes asynchronously with bounded hidden execution at a system path", async () => {
  const h = harness();
  assert.equal(await h.probe(), true);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.logs, []);
});

test("probe supports a non-default absolute Windows installation path", async () => {
  const h = harness({
    systemRoot: "D:\\Windows",
    execFile: (file, _args, _options, callback) => {
      assert.equal(file, "D:\\Windows\\System32\\dsregcmd.exe");
      callback(null, registered(), "");
    },
  });
  assert.equal(await h.probe(), true);
});

test("non-Windows platforms skip execution completely", async () => {
  for (const platform of ["darwin", "linux", "freebsd", "unknown"]) {
    const h = harness({ platform });
    assert.equal(await h.probe(), false);
    assert.equal(h.calls(), 0);
    assert.deepEqual(h.logs, [["Microsoft sign-in hint unavailable", { reason: "unsupported-platform" }]]);
  }
});

test("missing or unsupported system paths never fall back to PATH", async () => {
  for (const systemRoot of [undefined, "", "Windows", "\\Windows", "\\\\host\\share", "C:\\Windows\\..\\Users"]) {
    const h = harness({ systemRoot });
    assert.equal(await h.probe(), false);
    assert.equal(h.calls(), 0);
    assert.deepEqual(h.logs, [["Microsoft sign-in hint unavailable", { reason: "unsupported-system-path" }]]);
  }
});

test("failure, missing executable, timeout and buffer errors ignore even matching partial stdout", async () => {
  for (const [properties, reason] of [
    [{ code: "ENOENT" }, "executable-missing"],
    [{ code: 1 }, "probe-failed"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ killed: true, signal: "SIGTERM" }, "timeout"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "output-limit"],
  ] as const) {
    const h = harness({
      execFile: (_file, _args, _options, callback) => {
        const error = Object.assign(new Error("private account/device details"), properties, {
          stdout: joined(), stderr: "private diagnostics",
        });
        queueMicrotask(() => callback(error, joined(), "private diagnostics"));
      },
    });
    assert.equal(await h.probe(), false);
    assert.deepEqual(h.logs, [["Microsoft sign-in hint unavailable", { reason }]]);
  }
});

test("synchronous execution errors are sanitized and return false", async () => {
  const h = harness({ execFile: () => { throw new Error("private account/device details"); } });
  assert.equal(await h.probe(), false);
  assert.deepEqual(h.logs, [["Microsoft sign-in hint unavailable", { reason: "probe-failed" }]]);
});

test("successful but unsupported/unmatched output is sanitized and returns false", async () => {
  for (const output of ["unsupported command: private diagnostics", joined(other), "", joined() + "x".repeat(128 * 1024)]) {
    const h = harness({
      execFile: (_file, _args, _options, callback) => callback(null, output, "private diagnostics"),
    });
    assert.equal(await h.probe(), false);
    assert.deepEqual(h.logs, [["Microsoft sign-in hint unavailable", { reason: "no-matching-hint" }]]);
  }
});
