import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPortableLockfileRegistries,
  assertPolicyCapableNpm,
  assertReviewedInstallScripts,
  normalizeLockfileRegistryUrls,
} from "./check-lockfile-portability.mjs";
import {
  assertReviewedPackagePath,
  exitCodeForSignal,
  sanitizeElectronEnvironment,
} from "./run-reviewed-electron.mjs";
import {
  assertLockfileClosure,
  assertReviewedCopilotCliVersions,
  assertReviewedTessdataPins,
  assertWasmExcludedFromPackaging,
  buildArtisticSourceSpecs,
  buildComplianceSourceSpecs,
  buildNativeSourceSpecs,
  buildStaticRemoteMaterialSpecs,
  buildTesseractNoticeSpecs,
  buildTesseractSourceSpecs,
  deterministicGitConfigArgs,
  detectLinuxLibc,
  excludedWasmPackages,
  findPackageLicenseFiles,
  hasExpectedFileHeader,
  isCommitToken,
  isLicenseFileName,
  legalTextSpecs,
  nativePayloadCandidates,
  onnxRefForVersion,
  releaseTargets,
  resolveReviewedCommit,
  reviewedSharpLibvipsLicenseEntry,
  reviewedSharpLicenseEntry,
  reviewedMaterialHash,
  renderRelinking,
  selectNativePayload,
  splitSpdxAnd,
  verifyComplianceDirectory,
} from "./compliance.mjs";

const nativeVersions = {
  aom: "3.14.1",
  archive: "3.8.7",
  cairo: "1.18.4",
  cgif: "0.5.3",
  exif: "0.6.26",
  expat: "2.8.1",
  ffi: "3.5.2",
  fontconfig: "2.18.1",
  freetype: "2.14.3",
  fribidi: "1.0.16",
  glib: "2.89.0",
  harfbuzz: "14.2.1",
  heif: "1.23.0",
  highway: "1.4.0",
  imagequant: "2.4.1",
  lcms: "2.19.1",
  mozjpeg: "0826579",
  pango: "1.57.1",
  pixman: "0.46.4",
  png: "1.6.58",
  "proxy-libintl": "0.5",
  rsvg: "2.62.3",
  tiff: "732665c",
  uhdr: "13a058f",
  vips: "8.18.3",
  webp: "1.6.0",
  xml2: "2.15.3",
  "zlib-ng": "2.3.3",
};

const sourceCommits = {
  "mozjpeg@0826579": "08265790774cd0714832c9e675522acbe5581437",
  "tiff@732665c": "732665c2c8785cec3e1f46ba9908575f0f3a8059",
  "tiff@d01a94b": "d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d",
  "uhdr@13a058f": "13a058f452d846e43d4691f6885eeeaa8b0ea8d0",
  "uhdr@1acdbed": "1acdbed8c712e6923ebf9de4e7c8d8dda06509e9",
};

const specOptions = {
  platform: "win32",
  sharpVersion: "0.35.3",
  sharpLibvipsVersion: "1.3.2",
  electronVersion: "43.1.1",
  ffmpegRevision: "ad41607c61898cf7150e0fb20fe4bbabd44922a3",
  sourceCommits,
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoManifest = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const repoLock = JSON.parse(
  await readFile(path.join(repoRoot, "package-lock.json"), "utf8"),
);
const repoPolicy = JSON.parse(
  await readFile(path.join(repoRoot, "third_party", "compliance-policy.json"), "utf8"),
);

test("license filenames include common suffixed forms", () => {
  assert.equal(isLicenseFileName("LICENSE"), true);
  assert.equal(isLicenseFileName("LICENSE-MIT.txt"), true);
  assert.equal(isLicenseFileName("NOTICE.md"), true);
  assert.equal(isLicenseFileName("thirdpartynotices.txt"), true);
  assert.equal(isLicenseFileName("README.md"), false);
});

test("canonical legal texts use immutable reviewed sources", () => {
  for (const spec of legalTextSpecs) {
    assert.match(
      spec.url,
      /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//,
      `${spec.id} must use an immutable source revision`,
    );
  }
});

test("nested package legal files are discovered", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-licenses-"));
  try {
    await mkdir(path.join(root, "google"), { recursive: true });
    await mkdir(path.join(root, "vendor", "node-api"), { recursive: true });
    await writeFile(path.join(root, "LICENSE"), "root license");
    await writeFile(path.join(root, "google", "LICENSE"), "vendored license");
    await writeFile(
      path.join(root, "vendor", "node-api", "thirdpartynotices.txt"),
      "vendored notices",
    );
    assert.deepEqual(findPackageLicenseFiles(root), [
      "google/LICENSE",
      "LICENSE",
      "vendor/node-api/thirdpartynotices.txt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Tesseract WebAssembly source and notices are pinned to the reviewed build", () => {
  const sources = buildTesseractSourceSpecs(repoPolicy.tesseract);
  assert.equal(sources.length, 10);
  assert.deepEqual(
    new Set(sources.map(({ id }) => id)),
    new Set([
      "tesseract-js-core@7.0.0",
      ...Object.entries(repoPolicy.tesseract.sourceRevisions)
        .filter(([name]) => name !== "core")
        .map(([name, revision]) => `tesseract-core-${name}@${revision}`),
    ]),
  );
  for (const source of sources) {
    assert.match(source.gitRevision, /^[a-f0-9]{40}$/);
    assert.match(source.url, new RegExp(`${source.gitRevision}$`));
    assert.match(source.fileName, /\.tar$/);
  }

  const notices = buildTesseractNoticeSpecs(repoPolicy.tesseract);
  assert.equal(notices.length, 10);
  assert(notices.some(({ id }) => id === "tessdata-fast-license"));
  for (const notice of notices) {
    assert.doesNotMatch(notice.url, /\/(?:master|main|HEAD)(?:\/|$)/);
    assert.match(notice.outputPath, /^tesseract-core\//);
    assert.match(repoPolicy.remoteMaterials[notice.id], /^[a-f0-9]{64}$/);
  }
});

test("runtime tessdata pins match the reviewed model policy", async () => {
  const source = await readFile(
    path.join(repoRoot, "electron", "sensitive", "tessdata-source.ts"),
    "utf8",
  );
  assert.doesNotThrow(() =>
    assertReviewedTessdataPins(source, repoPolicy.tesseract.tessdata),
  );
  assert.throws(
    () =>
      assertReviewedTessdataPins(
        source.replace(repoPolicy.tesseract.tessdata.revision, "f".repeat(40)),
        repoPolicy.tesseract.tessdata,
      ),
    /has not been reviewed/,
  );
});

test("Artistic-2.0 packages retain exact Standard Version source", () => {
  const sources = buildArtisticSourceSpecs(repoLock, repoPolicy.artisticPackages);
  assert.equal(sources.length, 5);
  for (const source of sources) {
    assert.match(source.url, /^https:\/\/registry\.npmjs\.org\/[^/]+\/-\/[^/]+\.tgz$/);
    assert.match(source.reason, /Standard Version source/);
  }

  const changed = structuredClone(repoLock);
  changed.packages["node_modules/editions"].version = "99.0.0";
  assert.throws(
    () => buildArtisticSourceSpecs(changed, repoPolicy.artisticPackages),
    /have not been reviewed/,
  );
});

test("every reviewed source hash is referenced by the release manifest", () => {
  const darwinVersions = {
    ...nativeVersions,
    archive: "3.8.8",
    expat: "2.8.2",
    ffi: "3.6.0",
    glib: "2.89.1",
    heif: "1.23.1",
    pango: "1.58.0",
    rsvg: "2.62.90",
    tiff: "d01a94b",
    uhdr: "1acdbed",
  };
  const expected = [
    ...buildComplianceSourceSpecs(nativeVersions, repoLock, repoPolicy, "win32"),
    ...buildComplianceSourceSpecs(darwinVersions, repoLock, repoPolicy, "darwin"),
  ].map(({ id }) => id);
  assert.deepEqual(
    new Set(Object.keys(repoPolicy.sourceMaterials)),
    new Set(expected),
  );
});

test("native source manifest covers dependencies, build scripts, and patches", () => {
  const sources = buildNativeSourceSpecs(nativeVersions, specOptions);

  const ids = new Set(sources.map(({ id }) => id));
  for (const [dependency, version] of Object.entries(nativeVersions)) {
    assert(ids.has(`sharp-native-${dependency}@${version}`), `missing ${dependency}`);
  }
  for (const required of [
    "sharp",
    "sharp-libvips-build",
    "libvips-windows-build",
    "electron-ffmpeg",
    "electron",
    "electron-ffmpeg-patch-link-with-loader-path",
  ]) {
    assert(ids.has(required), `missing ${required}`);
  }
  const ffmpeg = sources.find(({ id }) => id === "electron-ffmpeg");
  assert.equal(
    ffmpeg.fileName,
    "electron-ffmpeg-ad41607c61898cf7150e0fb20fe4bbabd44922a3.tar",
  );
  assert.equal(
    ffmpeg.gitRepository,
    "https://chromium.googlesource.com/chromium/third_party/ffmpeg",
  );
  assert.doesNotMatch(ffmpeg.url, /\+archive/);
});

test("source ids are version qualified so both platform payloads coexist", () => {
  const windows = buildNativeSourceSpecs(nativeVersions, specOptions);
  const posix = buildNativeSourceSpecs(
    { ...nativeVersions, archive: "3.8.8", tiff: "d01a94b", uhdr: "1acdbed" },
    { ...specOptions, platform: "darwin" },
  );
  assert(windows.some(({ id }) => id === "sharp-native-archive@3.8.7"));
  assert(posix.some(({ id }) => id === "sharp-native-archive@3.8.8"));
  const shared = new Set(windows.map(({ id }) => id));
  assert(
    posix.some(({ id }) => id.startsWith("sharp-native-") && !shared.has(id)),
    "platform payloads must be able to pin different component versions",
  );
});

test("only components present in the payload manifest are required", () => {
  const trimmed = { ...nativeVersions };
  delete trimmed.aom;
  const ids = new Set(buildNativeSourceSpecs(trimmed, specOptions).map(({ id }) => id));
  assert.equal(ids.has("sharp-native-aom@3.14.1"), false);
  assert.equal([...ids].some((id) => id.startsWith("sharp-native-spng")), false);
});

test("an unknown payload component fails closed", () => {
  assert.throws(
    () => buildNativeSourceSpecs({ ...nativeVersions, brandnew: "1.0.0" }, specOptions),
    /has no reviewed source builder/,
  );
});

test("commit-identified components resolve to reviewed immutable revisions", () => {
  assert.equal(isCommitToken("732665c"), true);
  assert.equal(isCommitToken("4.7.1"), false);
  assert.equal(
    resolveReviewedCommit("tiff", "732665c", sourceCommits),
    "732665c2c8785cec3e1f46ba9908575f0f3a8059",
  );
  assert.throws(
    () => resolveReviewedCommit("tiff", "abcdef1", sourceCommits),
    /no reviewed 40-character upstream commit/,
  );
  assert.throws(
    () => resolveReviewedCommit("tiff", "732665c", { "tiff@732665c": "f".repeat(40) }),
    /does not extend the manifest token/,
  );

  const sources = buildNativeSourceSpecs(nativeVersions, specOptions);
  for (const [id, repository, revision] of [
    ["sharp-native-tiff@732665c", "https://gitlab.com/libtiff/libtiff.git", "732665c2c8785cec3e1f46ba9908575f0f3a8059"],
    ["sharp-native-uhdr@13a058f", "https://github.com/google/libultrahdr.git", "13a058f452d846e43d4691f6885eeeaa8b0ea8d0"],
    ["sharp-native-mozjpeg@0826579", "https://github.com/mozilla/mozjpeg.git", "08265790774cd0714832c9e675522acbe5581437"],
  ]) {
    const spec = sources.find((entry) => entry.id === id);
    assert(spec, `missing ${id}`);
    assert.equal(spec.gitRepository, repository);
    assert.equal(spec.gitRevision, revision);
    assert.doesNotMatch(spec.url, /archive\/refs/);
  }
});

test("commit-identified components fall back to tagged tarballs", () => {
  const sources = buildNativeSourceSpecs(
    { ...nativeVersions, tiff: "4.7.1", uhdr: "1.4.0", mozjpeg: "4.1.5" },
    specOptions,
  );
  assert.equal(
    sources.find(({ id }) => id === "sharp-native-tiff@4.7.1").gitRepository,
    undefined,
  );
  assert.match(
    sources.find(({ id }) => id === "sharp-native-uhdr@1.4.0").url,
    /archive\/refs\/tags\/v1\.4\.0\.tar\.gz$/,
  );
});

test("build patches match the platform that applies them", () => {
  const windows = new Set(buildNativeSourceSpecs(nativeVersions, specOptions).map(({ id }) => id));
  const posix = new Set(
    buildNativeSourceSpecs(nativeVersions, { ...specOptions, platform: "darwin" }).map(
      ({ id }) => id,
    ),
  );

  // Windows patches all live inside the build-win64-mxe archive.
  assert(windows.has("libvips-windows-build"));
  assert.equal([...windows].some((id) => id.startsWith("sharp-patch-")), false);

  assert.equal(posix.has("libvips-windows-build"), false);
  for (const required of [
    "sharp-patch-glib-without-gregex",
    "sharp-patch-libvips-soversion",
    "sharp-patch-mozjpeg-simd-fdct",
    "sharp-patch-uhdr-platform-detection",
  ]) {
    assert(posix.has(required), `missing ${required}`);
  }
  for (const removed of [
    "sharp-patch-aom",
    "sharp-patch-highway",
    "sharp-patch-libvips-heif",
  ]) {
    assert.equal(posix.has(removed), false, `${removed} is no longer applied upstream`);
  }
});

test("every source specification uses an immutable revision or release", () => {
  for (const platform of ["win32", "darwin"]) {
    for (const spec of buildNativeSourceSpecs(nativeVersions, { ...specOptions, platform })) {
      assert.doesNotMatch(
        spec.url,
        /\/(?:master|main|HEAD)(?:[/.]|$)|pull\/\d+\.(?:patch|diff)|patch-diff\.githubusercontent/,
        `${spec.id} must not reference a mutable upstream ref`,
      );
      if (spec.gitRevision) assert.match(spec.gitRevision, /^[0-9a-f]{40}$/);
    }
  }
});

test("git archives ignore host line-ending and global attribute settings", () => {
  assert.deepEqual(deterministicGitConfigArgs, [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "-c",
    "core.attributesFile=",
    "-c",
    "tar.umask=0002",
  ]);
});

test("unreviewed ONNX versions fail closed", () => {
  const policy = { onnxruntime: { "1.24.3": "v1.24.3" } };
  assert.equal(onnxRefForVersion("1.24.3", policy), "v1.24.3");
  assert.throws(
    () => onnxRefForVersion("1.24.4", policy),
    /has not been reviewed/,
  );
});

test("unreviewed GitHub Copilot CLI versions fail closed", () => {
  const reviewedLock = {
    packages: {
      "node_modules/@github/copilot": { version: "1.0.71" },
      "node_modules/@github/copilot-win32-x64": { version: "1.0.71" },
    },
  };
  assert.doesNotThrow(() =>
    assertReviewedCopilotCliVersions(reviewedLock, "1.0.71"),
  );

  const changedLock = structuredClone(reviewedLock);
  changedLock.packages["node_modules/@github/copilot-win32-x64"].version = "1.0.72";
  assert.throws(
    () => assertReviewedCopilotCliVersions(changedLock, "1.0.71"),
    /have not been reviewed/,
  );
});

test("platform Sharp/libvips packages use the reviewed LGPL text", () => {
  const pkg = {
    name: "@img/sharp-libvips-linux-x64",
    version: "1.2.4",
    license: "LGPL-3.0-or-later",
    lockPath: "node_modules/@img/sharp-libvips-linux-x64",
  };
  const entry = reviewedSharpLibvipsLicenseEntry(pkg, {
    sharpLibvips: { version: "1.2.4" },
  });
  assert.equal(entry.licenseSource, "licenses/LGPL-3.0.txt");
  assert.throws(
    () =>
      reviewedSharpLibvipsLicenseEntry(
        { ...pkg, version: "1.2.5" },
        { sharpLibvips: { version: "1.2.4" } },
      ),
    /No reviewed Sharp\/libvips license override/,
  );
  assert.throws(
    () =>
      reviewedSharpLibvipsLicenseEntry(
        { ...pkg, license: "UNKNOWN" },
        { sharpLibvips: { version: "1.2.4" } },
      ),
    /unexpected license metadata/,
  );
});

test("compound SPDX expressions are split into individual terms", () => {
  assert.deepEqual(splitSpdxAnd("Apache-2.0 AND LGPL-3.0-or-later AND MIT"), [
    "Apache-2.0",
    "LGPL-3.0-or-later",
    "MIT",
  ]);
  assert.deepEqual(splitSpdxAnd("(MIT AND Apache-2.0)"), ["MIT", "Apache-2.0"]);
  assert.deepEqual(splitSpdxAnd("MIT"), ["MIT"]);
  assert.deepEqual(splitSpdxAnd(undefined), []);
});

test("every declared Sharp license term resolves to concrete text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-sharp-license-"));
  try {
    await writeFile(
      path.join(root, "LICENSE"),
      "                              Apache License\n                        Version 2.0, January 2004\n",
    );
    const policy = { sharp: "0.35.3", sharpLibvips: { version: "1.3.2" } };
    const pkg = {
      name: "@img/sharp-win32-arm64",
      version: "0.35.3",
      license: "Apache-2.0 AND LGPL-3.0-or-later",
      lockPath: "node_modules/@img/sharp-win32-arm64",
      directory: root,
    };
    const entry = reviewedSharpLicenseEntry(pkg, policy, ["LICENSE"]);
    assert.equal(entry.licenseSource, "LICENSE, licenses/LGPL-3.0.txt");
    assert.match(entry.text, /Apache License/);
    assert.match(entry.text, /licenses\/LGPL-3\.0\.txt/);

    const wasm = reviewedSharpLicenseEntry(
      { ...pkg, name: "@img/sharp-wasm32", license: "Apache-2.0 AND LGPL-3.0-or-later AND MIT" },
      policy,
      ["LICENSE"],
    );
    assert.match(wasm.licenseSource, /canonical SPDX MIT text/);
    assert.match(wasm.text, /MIT License/);

    // The permissive half alone is never enough for a compound expression.
    assert.throws(
      () => reviewedSharpLicenseEntry(pkg, policy, []),
      /declares Apache-2\.0 but ships no Apache license text/,
    );
    assert.throws(
      () => reviewedSharpLicenseEntry({ ...pkg, license: "Apache-2.0 AND GPL-3.0" }, policy, ["LICENSE"]),
      /unexpected license metadata/,
    );
    assert.throws(
      () => reviewedSharpLicenseEntry({ ...pkg, version: "0.35.4" }, policy, ["LICENSE"]),
      /No reviewed Sharp license override/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exactly one architecture-matched native payload is packaged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-payload-"));
  try {
    const make = async (name) => {
      const directory = path.join(root, name.replaceAll("/", "_"));
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "versions.json"), JSON.stringify({ vips: "8.18.3" }));
      return { name, version: "0.35.3", directory, lockPath: `node_modules/${name}` };
    };
    const win64 = await make("@img/sharp-win32-x64");
    const winArm = await make("@img/sharp-win32-arm64");
    const wasm = await make("@img/sharp-wasm32");
    const rogue = await make("@img/sharp-linux-x64");

    assert.equal(
      selectNativePayload([winArm, wasm], { platform: "win32", arch: "arm64" }).name,
      "@img/sharp-win32-arm64",
    );
    assert.throws(
      () => selectNativePayload([wasm], { platform: "win32", arch: "arm64" }),
      /No Sharp native payload is installed/,
    );
    assert.throws(
      () => selectNativePayload([win64], { platform: "win32", arch: "arm64" }),
      /Unexpected Sharp native payload installed/,
    );
    assert.throws(
      () => selectNativePayload([winArm, rogue], { platform: "win32", arch: "arm64" }),
      /Unexpected Sharp native payload installed/,
    );
    assert.throws(
      () => selectNativePayload([winArm], { platform: "freebsd", arch: "x64" }),
      /is not a reviewed Sharp native platform/,
    );

    const musl = await make("@img/sharp-libvips-linuxmusl-x64");
    const glibc = await make("@img/sharp-libvips-linux-x64");
    // npm installs both Linux payloads on every host because package-lock.json cannot
    // record `libc`; the running C library decides which one is authoritative.
    assert.equal(
      selectNativePayload([musl, glibc], { platform: "linux", arch: "x64", libc: "glibc" }).name,
      "@img/sharp-libvips-linux-x64",
    );
    assert.equal(
      selectNativePayload([musl, glibc], { platform: "linux", arch: "x64", libc: "musl" }).name,
      "@img/sharp-libvips-linuxmusl-x64",
    );
    // With only one payload installed there is nothing to disambiguate, so a libc
    // misdetection must not turn a working install into a hard failure.
    assert.equal(
      selectNativePayload([musl], { platform: "linux", arch: "x64", libc: "glibc" }).name,
      "@img/sharp-libvips-linuxmusl-x64",
    );
    assert.throws(
      () => selectNativePayload([musl, glibc], { platform: "darwin", arch: "x64" }),
      /Unexpected Sharp native payload installed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(detectLinuxLibc({ getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) }), "glibc");
  assert.equal(detectLinuxLibc({ getReport: () => ({ header: {} }) }), "musl");
  assert.equal(detectLinuxLibc({ getReport: () => ({}) }), "musl");
  assert.ok(["glibc", "musl"].includes(detectLinuxLibc()));

  assert.deepEqual(Object.keys(nativePayloadCandidates).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  assert.deepEqual(releaseTargets, ["win32-x64", "win32-arm64", "darwin-arm64"]);
});

test("the lockfile resolves every dependency npm ci needs on other platforms", async () => {
  const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  assert.doesNotThrow(() => assertLockfileClosure(lock));

  // npm on Windows drops entries that only Linux and macOS install, which breaks the
  // documented `npm ci` source-install path.
  const pruned = structuredClone(lock);
  delete pruned.packages["node_modules/@emnapi/runtime"];
  assert.throws(
    () => assertLockfileClosure(pruned),
    /@img\/sharp-wasm32 -> @emnapi\/runtime/,
  );

  assert.doesNotThrow(() =>
    assertLockfileClosure({
      packages: {
        "": { dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { b: "^1.0.0" } },
        "node_modules/a/node_modules/b": { version: "1.0.0" },
      },
    }),
  );
  assert.throws(
    () => assertLockfileClosure({ packages: { "": { dependencies: { a: "^1.0.0" } } } }),
    /<root> -> a/,
  );
  assert.throws(() => assertLockfileClosure({}), /must declare a packages map/);
});

test("Electron notices are reviewed per release target", async () => {
  const policy = JSON.parse(
    await readFile(path.join(repoRoot, "third_party", "compliance-policy.json"), "utf8"),
  );
  // Chromium's notice file differs per platform, so a single reviewed hash would either
  // fail macOS or wave through an unreviewed Windows notice.
  assert.deepEqual(Object.keys(policy.electron.notices).sort(), [...releaseTargets].sort());
  const chromium = new Set(
    releaseTargets.map((target) => policy.electron.notices[target]["LICENSES.chromium.html"]),
  );
  assert.equal(chromium.size, 2, "Windows and macOS ship different Chromium notices");
  for (const target of releaseTargets) {
    assert.ok(policy.electron.distributions[target], `${target} needs a reviewed distribution`);
    for (const notice of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
      assert.match(policy.electron.notices[target][notice], /^[a-f0-9]{64}$/);
    }
  }
});

test("the WASM payload is excluded from every Electron artifact", () => {
  assert.deepEqual(excludedWasmPackages, [
    "@img/sharp-wasm32",
    "@img/sharp-freebsd-wasm32",
    "@img/sharp-webcontainers-wasm32",
    "@emnapi/runtime",
  ]);
  assert.doesNotThrow(() => assertWasmExcludedFromPackaging(repoManifest.build));
  for (const list of ["files", "win"]) {
    const build = structuredClone(repoManifest.build);
    const target = list === "files" ? build.files : build.win.files;
    target.splice(target.indexOf("!node_modules/@img/sharp-wasm32/**"), 1);
    assert.throws(
      () => assertWasmExcludedFromPackaging(build),
      /does not exclude @img\/sharp-wasm32/,
    );
  }
});

test("only supported release targets are packaged", () => {
  assert.equal(repoManifest.build.linux, undefined, "Linux is not a release target");
  assert.deepEqual(repoManifest.build.mac.target, ["dmg", "zip"]);
  assert.equal(repoManifest.build.win.target, "nsis");
});

test("the lockfile is registry-portable and install scripts are reviewed", async () => {
  assert.doesNotThrow(() => assertPortableLockfileRegistries(repoLock));
  assert.doesNotThrow(() => assertReviewedInstallScripts(repoLock, repoManifest));

  const internal = {
    packages: {
      "node_modules/example": {
        version: "1.0.0",
        resolved:
          "https://ms-feed-25.pkgs.visualstudio.com/feed/_packaging/npm/npm/registry/example/-/example-1.0.0.tgz",
      },
    },
  };
  assert.throws(
    () => assertPortableLockfileRegistries(internal),
    /non-portable resolved URLs/,
  );
  assert.equal(normalizeLockfileRegistryUrls(internal), 1);
  assert.equal(
    internal.packages["node_modules/example"].resolved,
    "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
  );
  assert.doesNotThrow(() => assertPortableLockfileRegistries(internal));

  const scriptLock = {
    packages: {
      "node_modules/native-alias": {
        version: "2.0.0",
        resolved: "https://registry.npmjs.org/native/-/native-2.0.0.tgz",
        hasInstallScript: true,
      },
      "node_modules/noisy": {
        version: "3.0.0",
        resolved: "https://registry.npmjs.org/noisy/-/noisy-3.0.0.tgz",
        hasInstallScript: true,
      },
    },
  };
  assert.doesNotThrow(() =>
    assertReviewedInstallScripts(scriptLock, {
      allowScripts: { "native@2.0.0": true, noisy: false },
    }),
  );
  assert.throws(
    () =>
      assertReviewedInstallScripts(scriptLock, {
        allowScripts: { "native-alias": false },
      }),
    /does not match an install-script package/,
  );
  assert.throws(
    () =>
      assertReviewedInstallScripts(scriptLock, {
        allowScripts: { native: true },
      }),
    /must pin an installed package version/,
  );
  assert.throws(
    () => assertReviewedInstallScripts(scriptLock, { allowScripts: {} }),
    /has no reviewed decision/,
  );
  assert.doesNotThrow(() => assertPolicyCapableNpm("11.17.0"));
  assert.doesNotThrow(() => assertPolicyCapableNpm("12.0.0"));
  assert.throws(
    () => assertPolicyCapableNpm("11.16.0"),
    /npm 11\.17\.0 or newer/,
  );

  assert.deepEqual(
    sanitizeElectronEnvironment({
      ELECTRON_OVERRIDE_DIST_PATH: "unreviewed",
      npm_config_electron_customdir: "wrong-release",
      npm_config_electron_mirror: "https://example.invalid",
      npm_package_config_electron_customFilename: "wrong.zip",
      npm_package_config_electron_use_remote_checksums: "1",
      PATH: "retained",
    }),
    { PATH: "retained" },
  );
  assert.doesNotThrow(() =>
    assertReviewedPackagePath("electron.exe", "electron.exe"),
  );
  assert.throws(
    () => assertReviewedPackagePath("electron.exe", "unreviewed.exe"),
    /does not match the reviewed runtime/,
  );
  assert.equal(exitCodeForSignal("SIGINT"), 130);
  assert.equal(exitCodeForSignal("SIGTERM"), 143);
});

test("unreviewed source hashes fail closed", () => {
  assert.equal(
    reviewedMaterialHash("source", { source: "a".repeat(64) }, "Source material"),
    "a".repeat(64),
  );
  assert.throws(
    () => reviewedMaterialHash("missing", {}, "Source material"),
    /has no reviewed SHA-256/,
  );
});

test("relinking instructions use platform-specific native paths", () => {
  const sources = [
    "sharp-libvips-build",
    "electron",
    "electron-ffmpeg",
    "electron-ffmpeg-patch-link-with-loader-path",
  ].map((id) => ({ id, file: `sources/${id}.tar.gz` }));
  const native = {
    packages: [
      {
        name: "@img/sharp-libvips-darwin-arm64",
        binaries: [{ file: "lib/libvips-cpp.8.18.3.dylib", sha256: "a".repeat(64) }],
      },
    ],
    versions: { vips: "8.18.3", glib: "2.89.1", cairo: "1.18.4" },
  };
  const policy = {
    electron: { version: "43.1.1", ffmpegRevision: "abc" },
    sharp: "0.35.3",
    sharpLibvips: { version: "1.3.2" },
  };
  const mac = renderRelinking(native, { mode: "full", sources }, policy, "darwin");
  assert.match(
    mac,
    /Contents\/Frameworks\/Electron Framework\.framework\/Versions\/A\/Libraries\/libffmpeg\.dylib/,
  );
  assert.doesNotMatch(mac, /build-win64-mxe/);
  assert.match(
    mac,
    /Contents\/Resources\/app\.asar\.unpacked\/node_modules\/@img\/sharp-libvips-darwin-arm64\/lib\/libvips-cpp\.8\.18\.3\.dylib/,
  );
  assert.match(mac, /takes no technical measure to prevent a\r?\nmodified replacement from running/);
  assert.match(mac, /reverse engineer Skill Recorder to/);
  assert.match(mac, /- Sharp: 0\.35\.3/);
  assert.match(mac, /- Sharp\/libvips packaging: 1\.3\.2/);
  assert.match(mac, /- libvips: 8\.18\.3/);

  const linux = renderRelinking(native, { mode: "full", sources }, policy, "linux");
  assert.match(linux, /libffmpeg\.so beside the Skill Recorder executable/);
});

test("distributed notices match the reviewed Sharp and libvips versions", async () => {
  const notices = await readFile(path.join(repoRoot, "THIRD-PARTY-NOTICES.md"), "utf8");
  assert.match(notices, new RegExp(`sharp/tree/v${repoPolicy.sharp.replaceAll(".", "\\.")}`));
  assert.match(
    notices,
    new RegExp(`sharp-libvips v${repoPolicy.sharpLibvips.version.replaceAll(".", "\\.")}`),
  );
  assert.match(notices, /libvips\r?\n\s+\[`v8\.18\.3`\]/);
  assert.match(notices, /@img\/sharp-wasm32/);
  assert.doesNotMatch(notices, /v0\.34\.5|v1\.2\.4|v8\.17\.3/);
});

test("archive validation rejects HTML challenge pages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-archive-"));
  try {
    const challenge = path.join(root, "source.tar.gz");
    await writeFile(challenge, `<!doctype html>${"x".repeat(200)}`);
    assert.equal(await hasExpectedFileHeader("source.tar.gz", challenge), false);

    const gzip = path.join(root, "valid.tar.gz");
    await writeFile(gzip, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(200)]));
    assert.equal(await hasExpectedFileHeader("valid.tar.gz", gzip), true);

    const tar = path.join(root, "valid.tar");
    const tarHeader = Buffer.alloc(512);
    tarHeader.write("ustar", 257, "ascii");
    await writeFile(tar, tarHeader);
    assert.equal(await hasExpectedFileHeader("valid.tar", tar), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("licenses-only bundles cannot pass release verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-compliance-"));
  try {
    const files = [
      "COMPLIANCE-README.md",
      "LICENSE",
      "NATIVE-COMPONENTS.json",
      "NATIVE-THIRD-PARTY-NOTICES.md",
      "RELINKING.md",
      "THIRD-PARTY-NOTICES.md",
    ];
    await Promise.all(files.map((file) => writeFile(path.join(root, file), `${file}\n`)));
    await writeFile(path.join(root, "THIRD-PARTY-LICENSES.txt"), "x".repeat(1_100));
    await writeFile(
      path.join(root, "LICENSE-INVENTORY.json"),
      JSON.stringify({ packages: [{ name: "example" }], unresolved: [] }),
    );
    await writeFile(
      path.join(root, "REMOTE-MATERIALS.json"),
      JSON.stringify({ materials: [] }),
    );
    await writeFile(
      path.join(root, "SOURCE-MANIFEST.json"),
      JSON.stringify({ mode: "licenses-only", sources: [] }),
    );

    await verifyComplianceDirectory(root, {
      requireSources: false,
      requireRemoteMaterials: false,
    });
    await assert.rejects(
      verifyComplianceDirectory(root, {
        requireSources: true,
        requireRemoteMaterials: false,
      }),
      /requires full corresponding sources/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source and release instructions remain compliance-preserving", async () => {
  const [
    windowsInstaller,
    unixInstaller,
    instructions,
    readme,
    releasing,
    windowsWorkflow,
    electronInstaller,
  ] = await Promise.all([
    readFile(path.join(repoRoot, "install.ps1"), "utf8"),
    readFile(path.join(repoRoot, "install.sh"), "utf8"),
    readFile(path.join(repoRoot, "INSTALL.md"), "utf8"),
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "RELEASING.md"), "utf8"),
    readFile(
      path.join(repoRoot, ".github", "workflows", "windows.yml"),
      "utf8",
    ),
    readFile(
      path.join(repoRoot, "scripts", "install-reviewed-electron.mjs"),
      "utf8",
    ),
  ]);

  assert.match(windowsInstaller, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(
    windowsInstaller,
    /https:\/\/codeload\.github\.com\/microsoft\/skill-recorder\/zip\/\$Commit/,
  );
  assert.match(windowsInstaller, /https:\/\/nodejs\.org\/dist\/index\.json/);
  assert.doesNotMatch(
    windowsInstaller,
    /NPM_CONFIG_(?:REGISTRY|REPLACE_REGISTRY_HOST)/,
  );
  assert.match(
    windowsInstaller,
    /https:\/\/github\.com\/electron\/electron\/releases\/download\//,
  );
  assert.match(windowsInstaller, /SHASUMS256\.txt/);
  assert.match(windowsInstaller, /Get-AuthenticodeSignature/);
  assert.match(windowsInstaller, /OpenJS Foundation/);
  assert.match(windowsInstaller, /GitHub, Inc\\\./);
  assert.match(windowsInstaller, /@github\\copilot\\LICENSE\.md/);
  assert.match(windowsInstaller, /@github\\copilot-win32-\$architecture/);
  assert.match(windowsInstaller, /node_modules\\electron\\dist\\LICENSES\.chromium\.html/);
  assert.match(windowsInstaller, /third_party\\compliance-policy\.json/);
  assert.match(windowsInstaller, /Assert-ReviewedElectronDistribution/);
  assert.match(windowsInstaller, /EnvironmentVariableTarget\]::Machine/);
  assert.doesNotMatch(
    windowsInstaller,
    /RuntimeInformation\]::OSArchitecture/,
  );
  assert.match(
    windowsInstaller,
    /\$compatibleReleases = @\(\s+foreach \(\$release in \$index\)/,
  );
  assert.doesNotMatch(
    windowsInstaller,
    /\$index = @\(Get-Content [^\r\n]+ConvertFrom-Json\)/,
  );
  assert.match(windowsInstaller, /\$versionOutput = @\(& \$nodeExe --version\)/);
  assert.doesNotMatch(
    windowsInstaller,
    /\(& \$nodeExe [^\r\n]+\| Select-Object -First 1\)/,
  );
  assert.match(
    windowsInstaller,
    /"ci",\s+"--no-audit",\s+"--no-fund",\s+"--ignore-scripts=false",\s+"--dangerously-allow-all-scripts=false",\s+"--strict-allow-scripts"/,
  );
  assert.match(windowsInstaller, /"scripts\\check-lockfile-portability\.mjs"/);
  assert.match(windowsInstaller, /"scripts\\install-reviewed-electron\.mjs"/);
  assert.doesNotMatch(windowsInstaller, /node_modules\\electron\\install\.js/);
  assert.match(
    windowsInstaller,
    /Move-DirectoryTree -Source \$buildDirectory -Destination \$sourceDirectory/,
  );
  assert.match(
    windowsInstaller,
    /Move-DirectoryTree -Source \$expandedDirectory -Destination \$runtimeDirectory/,
  );
  assert.match(windowsInstaller, /@?\("run", "compliance:licenses"\)/);
  assert.match(windowsInstaller, /@?\("run", "build"\)/);
  assert.doesNotMatch(
    windowsInstaller,
    /github\.com\/microsoft\/skill-recorder\/releases\/download/i,
  );
  assert.doesNotMatch(windowsInstaller, /\/(?:master|main)\/install\.ps1/i);

  assert.match(windowsInstaller, /"Skill Recorder \(Source\)\.lnk"/);
  assert.match(windowsInstaller, /SpecialFolder "Programs"/);
  assert.match(windowsInstaller, /SpecialFolder "DesktopDirectory"/);
  assert.match(windowsInstaller, /SKILL_RECORDER_NO_DESKTOP_SHORTCUT -ne "1"/);
  assert.match(
    windowsInstaller,
    /Get-CachedDownload `\r?\n\s+-Uri "\$baseUri\/\$archiveName" `\r?\n\s+-CachePath \$archivePath `\r?\n\s+-ExpectedSha256 \$expectedHash/,
  );
  assert.match(windowsInstaller, /Remove-CachedDownload -CachePath \$archivePath/);
  assert.match(windowsInstaller, /Remove-CachedDownload -CachePath \$sourceArchive/);

  assert.match(unixInstaller, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(
    unixInstaller,
    /https:\/\/codeload\.github\.com\/microsoft\/skill-recorder\/tar\.gz\/\$COMMIT/,
  );
  assert.match(unixInstaller, /https:\/\/nodejs\.org\/dist\/latest-v24\.x/);
  assert.doesNotMatch(
    unixInstaller,
    /NPM_CONFIG_(?:REGISTRY|REPLACE_REGISTRY_HOST)/,
  );
  assert.match(
    unixInstaller,
    /https:\/\/github\.com\/electron\/electron\/releases\/download\//,
  );
  assert.match(unixInstaller, /SHASUMS256\.txt/);
  assert.match(
    unixInstaller,
    /"\$NPM" ci \\\s+--no-audit \\\s+--no-fund \\\s+--ignore-scripts=false \\\s+--dangerously-allow-all-scripts=false \\\s+--strict-allow-scripts/,
  );
  assert.match(
    unixInstaller,
    /"\$NODE" "scripts\/check-lockfile-portability\.mjs"/,
  );
  assert.match(
    unixInstaller,
    /"\$NODE" "scripts\/install-reviewed-electron\.mjs"/,
  );
  assert.doesNotMatch(unixInstaller, /node_modules\/electron\/install\.js/);
  assert.match(unixInstaller, /"\$NPM" run compliance:licenses/);
  assert.match(unixInstaller, /"\$NPM" run build/);
  assert.match(unixInstaller, /\.compliance\/licenses\/LGPL-3\.0\.txt/);
  assert.match(unixInstaller, /@github\/copilot-\$\{PLATFORM\}-\$\{ARCHITECTURE\}/);
  assert.doesNotMatch(
    unixInstaller,
    /github\.com\/microsoft\/skill-recorder\/releases\/download/i,
  );
  assert.doesNotMatch(unixInstaller, /\/(?:master|main)\/install\.sh/i);

  assert.match(instructions, /generated build is for local execution only/i);
  assert.match(instructions, /npm ci/);
  assert.match(instructions, /full 40-character commit SHA/i);
  assert.match(instructions, /npm 11\.17/i);
  assert.match(instructions, /macOS/);
  assert.match(instructions, /Ubuntu/);
  assert.match(instructions, /complete generated\s+compliance bundle/i);
  assert.doesNotMatch(instructions, /raw\.githubusercontent\.com\/[^ \n]+\/(?:master|main)\//i);
  assert.match(electronInstaller, /createHash\("sha256"\)/);
  assert.match(electronInstaller, /@electron-internal\/extract-zip/);
  assert.match(electronInstaller, /@electron\/get/);
  assert.match(electronInstaller, /checksums,/);
  assert.match(electronInstaller, /initializeProxy\(\)/);
  assert.match(
    electronInstaller,
    /https:\/\/github\.com\/electron\/electron\/releases\/download\//,
  );
  assert.equal(
    repoManifest.scripts.dev,
    "node scripts/run-reviewed-electron.mjs dev",
  );
  assert.equal(
    repoManifest.scripts.start,
    "node scripts/run-reviewed-electron.mjs start",
  );
  assert.match(instructions, /SKILL_RECORDER_NO_DESKTOP_SHORTCUT=1/);
  assert.match(instructions, /GetFolderPath\('DesktopDirectory'\)/);
  assert.match(readme, /\[`INSTALL\.md`\]\(INSTALL\.md\)/);
  assert.match(readme, /\[`RELEASING\.md`\]\(RELEASING\.md\)/);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com\/[^ \n]+\/(?:master|main)\//i);
  assert.match(releasing, /source-only releases.*are the default/i);
  assert.match(releasing, /npm version 0\.2\.0 --no-git-tag-version/);
  assert.match(releasing, /full release commit SHA/i);
  assert.match(releasing, /git",\["cat-file","blob"/);
  assert.match(releasing, /not working-tree\s+files/i);
  assert.match(releasing, /SHA-256 values for `install\.ps1` and `install\.sh`/i);
  assert.match(releasing, /complete, version-matched\s+compliance bundle/i);
  assert.match(releasing, /Tesseract\.js-core/);
  assert.match(instructions, /Tesseract WebAssembly component notices/);
  assert.match(releasing, /Never silently replace an asset or move a release tag/i);
  assert.match(
    windowsWorkflow,
    /- name: Test commit-pinned source installation\r?\n\s+shell: powershell/,
  );
});
