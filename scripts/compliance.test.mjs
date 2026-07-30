import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertReviewedCopilotCliVersions,
  buildNativeSourceSpecs,
  deterministicGitConfigArgs,
  findPackageLicenseFiles,
  hasExpectedFileHeader,
  isLicenseFileName,
  legalTextSpecs,
  onnxRefForVersion,
  reviewedSharpLibvipsLicenseEntry,
  reviewedMaterialHash,
  renderRelinking,
  verifyComplianceDirectory,
} from "./compliance.mjs";

const nativeVersions = {
  aom: "3.13.1",
  archive: "3.8.2",
  cairo: "1.18.4",
  cgif: "0.5.0",
  exif: "0.6.25",
  expat: "2.7.3",
  ffi: "3.5.2",
  fontconfig: "2.17.1",
  freetype: "2.14.1",
  fribidi: "1.0.16",
  glib: "2.86.1",
  harfbuzz: "12.1.0",
  heif: "1.20.2",
  highway: "1.3.0",
  imagequant: "2.4.1",
  lcms: "2.17",
  mozjpeg: "0826579",
  pango: "1.57.0",
  pixman: "0.46.4",
  png: "1.6.50",
  "proxy-libintl": "0.5",
  rsvg: "2.61.2",
  spng: "0.7.4",
  tiff: "4.7.1",
  vips: "8.17.3",
  webp: "1.6.0",
  xml2: "2.15.1",
  "zlib-ng": "2.2.5",
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("native source manifest covers dependencies, build scripts, and patches", () => {
  const sources = buildNativeSourceSpecs(nativeVersions, {
    platform: "win32",
    sharpVersion: "0.34.5",
    sharpLibvipsVersion: "1.2.4",
    electronVersion: "43.1.1",
    ffmpegRevision: "ad41607c61898cf7150e0fb20fe4bbabd44922a3",
  });

  const ids = new Set(sources.map(({ id }) => id));
  for (const dependency of Object.keys(nativeVersions)) {
    assert(ids.has(`sharp-native-${dependency}`), `missing ${dependency}`);
  }
  for (const required of [
    "sharp",
    "sharp-libvips-build",
    "libvips-windows-build",
    "electron-ffmpeg",
    "electron",
    "electron-ffmpeg-patch-link-with-loader-path",
    "sharp-patch-glib-without-gregex",
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
    packages: [{ name: "@img/sharp-libvips-darwin-arm64" }],
    versions: { vips: "8.17.3", glib: "2.86.1", cairo: "1.18.4" },
  };
  const policy = {
    electron: { version: "43.1.1", ffmpegRevision: "abc" },
    sharp: "0.34.5",
    sharpLibvips: { version: "1.2.4" },
  };
  const mac = renderRelinking(native, { mode: "full", sources }, policy, "darwin");
  assert.match(
    mac,
    /Contents\/Frameworks\/Electron Framework\.framework\/Versions\/A\/Libraries\/libffmpeg\.dylib/,
  );
  assert.doesNotMatch(mac, /build-win64-mxe/);

  const linux = renderRelinking(native, { mode: "full", sources }, policy, "linux");
  assert.match(linux, /libffmpeg\.so beside the Skill Recorder executable/);
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
  ]);

  assert.match(windowsInstaller, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(
    windowsInstaller,
    /https:\/\/codeload\.github\.com\/microsoft\/skill-recorder\/zip\/\$Commit/,
  );
  assert.match(windowsInstaller, /https:\/\/nodejs\.org\/dist\/index\.json/);
  assert.match(windowsInstaller, /NPM_CONFIG_REGISTRY = "https:\/\/registry\.npmjs\.org\/"/);
  assert.match(
    windowsInstaller,
    /ELECTRON_MIRROR = "https:\/\/github\.com\/electron\/electron\/releases\/download\/"/,
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
  assert.match(windowsInstaller, /@?\("ci", "--no-audit", "--no-fund"\)/);
  assert.match(windowsInstaller, /@?\("node_modules\\electron\\install\.js"\)/);
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
  assert.match(unixInstaller, /NPM_CONFIG_REGISTRY="https:\/\/registry\.npmjs\.org\/"/);
  assert.match(
    unixInstaller,
    /ELECTRON_MIRROR="https:\/\/github\.com\/electron\/electron\/releases\/download\/"/,
  );
  assert.match(unixInstaller, /SHASUMS256\.txt/);
  assert.match(unixInstaller, /"\$NPM" ci --no-audit --no-fund/);
  assert.match(unixInstaller, /"\$NODE" "node_modules\/electron\/install\.js"/);
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
  assert.match(instructions, /macOS/);
  assert.match(instructions, /Ubuntu/);
  assert.match(instructions, /complete generated\s+compliance bundle/i);
  assert.doesNotMatch(instructions, /raw\.githubusercontent\.com\/[^ \n]+\/(?:master|main)\//i);
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
  assert.match(releasing, /Never silently replace an asset or move a release tag/i);
  assert.match(
    windowsWorkflow,
    /- name: Test commit-pinned source installation\r?\n\s+shell: powershell/,
  );
});
