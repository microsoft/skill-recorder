import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const execFileAsync = promisify(execFile);
export const deterministicGitConfigArgs = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.attributesFile=",
  "-c",
  "tar.umask=0002",
];
export const repositoryRoot = path.resolve(moduleDir, "..");
export const complianceOutput = path.join(repositoryRoot, ".compliance");

const policyPath = path.join(repositoryRoot, "third_party", "compliance-policy.json");
const gccLicenseMirrorRevision = "7da4eb256f169fdc6bf3849b247d81f2e9404eb3";
const gccLicenseMirror =
  `https://raw.githubusercontent.com/gcc-mirror/gcc/${gccLicenseMirrorRevision}`;
const mozillaLicenseRevision = "6efbc1d7604a22fae6ba145d1c3637f0bec7b1e6";
const mozillaLicense =
  `https://raw.githubusercontent.com/mozilla/grcov/${mozillaLicenseRevision}`;
const spdxLicenseRevision = "b8d6af45ad2fcfed61bb85a8ad068aa4a77eadf9";
const spdxLicenseText =
  `https://raw.githubusercontent.com/spdx/license-list-data/${spdxLicenseRevision}/text`;
const licenseFilePattern =
  /^(?:(?:licen[cs]e|copying|notice|copyright)(?:[-._].*)?|third[-_. ]?party[-_. ]?notices?(?:[-._].*)?)$/i;
const requiredComplianceFiles = [
  "COMPLIANCE-README.md",
  "LICENSE",
  "LICENSE-INVENTORY.json",
  "NATIVE-COMPONENTS.json",
  "NATIVE-THIRD-PARTY-NOTICES.md",
  "RELINKING.md",
  "REMOTE-MATERIALS.json",
  "SOURCE-MANIFEST.json",
  "THIRD-PARTY-LICENSES.txt",
  "THIRD-PARTY-NOTICES.md",
];

export const legalTextSpecs = [
  {
    id: "gpl-3.0",
    fileName: "GPL-3.0.txt",
    url: `${gccLicenseMirror}/COPYING3`,
    marker: "GNU GENERAL PUBLIC LICENSE",
  },
  {
    id: "lgpl-2.1",
    fileName: "LGPL-2.1.txt",
    url: `${gccLicenseMirror}/COPYING.LIB`,
    marker: "GNU LESSER GENERAL PUBLIC LICENSE",
  },
  {
    id: "lgpl-3.0",
    fileName: "LGPL-3.0.txt",
    url: `${gccLicenseMirror}/COPYING3.LIB`,
    marker: "GNU LESSER GENERAL PUBLIC LICENSE",
  },
  {
    id: "mpl-2.0",
    fileName: "MPL-2.0.txt",
    url: `${mozillaLicense}/LICENSE-MPL-2.0`,
    marker: "Mozilla Public License Version 2.0",
  },
  {
    id: "artistic-2.0",
    fileName: "Artistic-2.0.txt",
    url: `${spdxLicenseText}/Artistic-2.0.txt`,
    marker: "The Artistic License 2.0",
  },
];

/**
 * Sharp ships a WebAssembly build that npm installs on every platform because
 * `@img/sharp-wasm32` itself declares no `os`/`cpu`; only its `freebsd`/`webcontainers`
 * wrappers do. It is never loaded by the packaged application, so it and its
 * WASM-only runtime dependency are excluded from every Electron artifact instead of
 * receiving static-LGPL treatment.
 */
export const excludedWasmPackages = [
  "@img/sharp-wasm32",
  "@img/sharp-freebsd-wasm32",
  "@img/sharp-webcontainers-wasm32",
  "@emnapi/runtime",
];

/**
 * The single native payload that is actually packaged for each platform. Windows links
 * libvips into `@img/sharp-win32-*`; every other platform loads a separate
 * `@img/sharp-libvips-*` package, which is the only one carrying `versions.json` and the
 * upstream third-party notices.
 */
export const nativePayloadCandidates = {
  "win32-x64": ["@img/sharp-win32-x64"],
  "win32-arm64": ["@img/sharp-win32-arm64"],
  "darwin-x64": ["@img/sharp-libvips-darwin-x64"],
  "darwin-arm64": ["@img/sharp-libvips-darwin-arm64"],
  "linux-x64": ["@img/sharp-libvips-linux-x64", "@img/sharp-libvips-linuxmusl-x64"],
  "linux-arm64": ["@img/sharp-libvips-linux-arm64", "@img/sharp-libvips-linuxmusl-arm64"],
};

/** Targets that may produce a redistributable artifact and must pass full source preparation. */
export const releaseTargets = ["win32-x64", "win32-arm64", "darwin-arm64"];

/**
 * npm does not persist the `libc` field into `package-lock.json`, so `npm ci` installs both
 * the glibc and musl Linux payloads regardless of the host. Their manifests are identical,
 * but only one is loadable, so the running C library decides which one is authoritative.
 */
export function detectLinuxLibc(report = process.report) {
  const glibcVersion = report?.getReport?.()?.header?.glibcVersionRuntime;
  return typeof glibcVersion === "string" && glibcVersion.length > 0 ? "glibc" : "musl";
}

const nativeBinaryPattern = /\.(?:node|dll|dylib|so(?:\.\d+)*)$/;

/** Manifest tokens such as `732665c` or `0826579` identify a Git commit, not a release. */
export function isCommitToken(version) {
  return /^[0-9a-f]{7,40}$/.test(String(version ?? ""));
}

export function resolveReviewedCommit(component, version, sourceCommits) {
  const key = `${component}@${version}`;
  const resolved = sourceCommits?.[key];
  if (!/^[0-9a-f]{40}$/.test(resolved ?? "")) {
    throw new Error(
      `Sharp native component ${key} is identified by an abbreviated Git commit with no ` +
        "reviewed 40-character upstream commit. Add it to sourceCommits in " +
        "third_party/compliance-policy.json.",
    );
  }
  if (!resolved.startsWith(version)) {
    throw new Error(
      `Reviewed commit ${resolved} for ${key} does not extend the manifest token ${version}.`,
    );
  }
  return resolved;
}

function gitArchiveSpec(name, gitRepository, commitWebBase, gitRevision) {
  return {
    fileName: `${name}-${gitRevision}.tar`,
    url: `${commitWebBase}/${gitRevision}`,
    gitRepository,
    gitRevision,
    archivePrefix: `${name}-${gitRevision}/`,
  };
}
const tesseractCoreSources = {
  core: {
    archiveName: "tesseract-js-core",
    gitRepository: "https://github.com/naptha/tesseract.js-core.git",
    webBase: "https://github.com/naptha/tesseract.js-core/tree",
  },
  giflib: {
    archiveName: "tesseract-core-giflib",
    gitRepository: "https://github.com/mirrorer/giflib.git",
    rawBase: "https://raw.githubusercontent.com/mirrorer/giflib",
    webBase: "https://github.com/mirrorer/giflib/tree",
  },
  leptonica: {
    archiveName: "tesseract-core-leptonica",
    gitRepository: "https://github.com/DanBloomberg/leptonica.git",
    rawBase: "https://raw.githubusercontent.com/DanBloomberg/leptonica",
    webBase: "https://github.com/DanBloomberg/leptonica/tree",
  },
  libjpeg: {
    archiveName: "tesseract-core-libjpeg",
    gitRepository: "https://github.com/LuaDist/libjpeg.git",
    rawBase: "https://raw.githubusercontent.com/LuaDist/libjpeg",
    webBase: "https://github.com/LuaDist/libjpeg/tree",
  },
  libpng: {
    archiveName: "tesseract-core-libpng",
    gitRepository: "https://github.com/glennrp/libpng.git",
    rawBase: "https://raw.githubusercontent.com/glennrp/libpng",
    webBase: "https://github.com/glennrp/libpng/tree",
  },
  libtiff: {
    archiveName: "tesseract-core-libtiff",
    gitRepository: "https://gitlab.com/libtiff/libtiff.git",
    rawBase: "https://gitlab.com/libtiff/libtiff/-/raw",
    webBase: "https://gitlab.com/libtiff/libtiff/-/tree",
  },
  libwebp: {
    archiveName: "tesseract-core-libwebp",
    gitRepository: "https://github.com/webmproject/libwebp.git",
    rawBase: "https://raw.githubusercontent.com/webmproject/libwebp",
    webBase: "https://github.com/webmproject/libwebp/tree",
  },
  openlibm: {
    archiveName: "tesseract-core-openlibm",
    gitRepository: "https://github.com/JuliaMath/openlibm.git",
    rawBase: "https://raw.githubusercontent.com/JuliaMath/openlibm",
    webBase: "https://github.com/JuliaMath/openlibm/tree",
  },
  tesseract: {
    archiveName: "tesseract-core-tesseract",
    gitRepository: "https://github.com/Balearica/tesseract.git",
    rawBase: "https://raw.githubusercontent.com/Balearica/tesseract",
    webBase: "https://github.com/Balearica/tesseract/tree",
  },
  zlib: {
    archiveName: "tesseract-core-zlib",
    gitRepository: "https://github.com/madler/zlib.git",
    rawBase: "https://raw.githubusercontent.com/madler/zlib",
    webBase: "https://github.com/madler/zlib/tree",
  },
};

const tesseractCoreNoticeFiles = {
  giflib: {
    path: "COPYING",
    outputFile: "giflib-COPYING.txt",
    marker: "The GIFLIB distribution is Copyright",
  },
  leptonica: {
    path: "leptonica-license.txt",
    outputFile: "leptonica-LICENSE.txt",
    marker: "Copyright (C) 2001-2020 Leptonica",
  },
  libjpeg: {
    path: "README",
    outputFile: "libjpeg-README.txt",
    marker: "LEGAL ISSUES",
  },
  libpng: {
    path: "LICENSE",
    outputFile: "libpng-LICENSE.txt",
    marker: "PNG Reference Library License version 2",
  },
  libtiff: {
    path: "COPYRIGHT",
    outputFile: "libtiff-COPYRIGHT.txt",
    marker: "Copyright (c) 1988-1997 Sam Leffler",
  },
  libwebp: {
    path: "COPYING",
    outputFile: "libwebp-COPYING.txt",
    marker: "Copyright (c) 2010, Google Inc.",
  },
  openlibm: {
    path: "LICENSE.md",
    outputFile: "openlibm-LICENSE.md",
    marker: "OpenLibm contains code that is covered by various licenses.",
  },
  tesseract: {
    path: "LICENSE",
    outputFile: "tesseract-LICENSE.txt",
    marker: "Apache License",
  },
  zlib: {
    path: "README",
    outputFile: "zlib-README.txt",
    marker: "ZLIB DATA COMPRESSION LIBRARY",
  },
}

const sourceBuilders = {
  aom: (version) => ({
    fileName: `libaom-${version}.tar.gz`,
    url: `https://storage.googleapis.com/aom-releases/libaom-${version}.tar.gz`,
  }),
  archive: (version) => ({
    fileName: `libarchive-${version}.tar.xz`,
    url: `https://github.com/libarchive/libarchive/releases/download/v${version}/libarchive-${version}.tar.xz`,
  }),
  cairo: (version) => ({
    fileName: `cairo-${version}.tar.xz`,
    url: `https://cairographics.org/releases/cairo-${version}.tar.xz`,
  }),
  cgif: (version) => ({
    fileName: `cgif-${version}.tar.gz`,
    url: `https://github.com/dloebl/cgif/archive/refs/tags/v${version}.tar.gz`,
  }),
  exif: (version) => ({
    fileName: `libexif-${version}.tar.xz`,
    url: `https://github.com/libexif/libexif/releases/download/v${version}/libexif-${version}.tar.xz`,
  }),
  expat: (version) => ({
    fileName: `expat-${version}.tar.xz`,
    url:
      `https://github.com/libexpat/libexpat/releases/download/` +
      `R_${version.replaceAll(".", "_")}/expat-${version}.tar.xz`,
  }),
  ffi: (version) => ({
    fileName: `libffi-${version}.tar.gz`,
    url: `https://github.com/libffi/libffi/releases/download/v${version}/libffi-${version}.tar.gz`,
  }),
  fontconfig: (version) => ({
    fileName: `fontconfig-${version}.tar.gz`,
    url: `https://codeload.github.com/fontconfig/fontconfig/tar.gz/refs/tags/${version}`,
  }),
  freetype: (version) => ({
    fileName: `freetype-${version}.tar.gz`,
    url:
      "https://github.com/freetype/freetype/archive/refs/tags/" +
      `VER-${version.replaceAll(".", "-")}.tar.gz`,
  }),
  fribidi: (version) => ({
    fileName: `fribidi-${version}.tar.xz`,
    url: `https://github.com/fribidi/fribidi/releases/download/v${version}/fribidi-${version}.tar.xz`,
  }),
  glib: (version) => ({
    fileName: `glib-${version}.tar.xz`,
    url:
      `https://download.gnome.org/sources/glib/${withoutPatch(version)}/` +
      `glib-${version}.tar.xz`,
  }),
  harfbuzz: (version) => ({
    fileName: `harfbuzz-${version}.tar.gz`,
    url: `https://github.com/harfbuzz/harfbuzz/archive/refs/tags/${version}.tar.gz`,
  }),
  heif: (version) => ({
    fileName: `libheif-${version}.tar.gz`,
    url: `https://github.com/strukturag/libheif/releases/download/v${version}/libheif-${version}.tar.gz`,
  }),
  highway: (version) => ({
    fileName: `highway-${version}.tar.gz`,
    url: `https://github.com/google/highway/archive/refs/tags/${version}.tar.gz`,
  }),
  imagequant: (version) => ({
    fileName: `libimagequant-${version}.tar.gz`,
    url: `https://github.com/lovell/libimagequant/archive/refs/tags/v${version}.tar.gz`,
  }),
  lcms: (version) => ({
    fileName: `lcms2-${version}.tar.gz`,
    url: `https://github.com/mm2/Little-CMS/releases/download/lcms${version}/lcms2-${version}.tar.gz`,
  }),
  mozjpeg: (version, context) =>
    isCommitToken(version)
      ? gitArchiveSpec(
          "mozjpeg",
          "https://github.com/mozilla/mozjpeg.git",
          "https://github.com/mozilla/mozjpeg/commit",
          context.commit("mozjpeg", version),
        )
      : {
          fileName: `mozjpeg-${version}.tar.gz`,
          url: `https://github.com/mozilla/mozjpeg/archive/${version}.tar.gz`,
        },
  pango: (version) => ({
    fileName: `pango-${version}.tar.xz`,
    url:
      `https://download.gnome.org/sources/pango/${withoutPatch(version)}/` +
      `pango-${version}.tar.xz`,
  }),
  pixman: (version) => ({
    fileName: `pixman-${version}.tar.gz`,
    url: `https://cairographics.org/releases/pixman-${version}.tar.gz`,
  }),
  png: (version) => ({
    fileName: `libpng-${version}.tar.gz`,
    url: `https://github.com/pnggroup/libpng/archive/refs/tags/v${version}.tar.gz`,
  }),
  "proxy-libintl": (version) => ({
    fileName: `proxy-libintl-${version}.tar.gz`,
    url: `https://github.com/frida/proxy-libintl/archive/${version}.tar.gz`,
  }),
  rsvg: (version) => ({
    fileName: `librsvg-${version}.tar.xz`,
    url:
      `https://download.gnome.org/sources/librsvg/${withoutPatch(version)}/` +
      `librsvg-${version}.tar.xz`,
  }),
  spng: (version) => ({
    fileName: `libspng-${version}.tar.gz`,
    url: `https://github.com/randy408/libspng/archive/refs/tags/v${version}.tar.gz`,
  }),
  tiff: (version, context) =>
    isCommitToken(version)
      ? gitArchiveSpec(
          "libtiff",
          "https://gitlab.com/libtiff/libtiff.git",
          "https://gitlab.com/libtiff/libtiff/-/commit",
          context.commit("tiff", version),
        )
      : {
          fileName: `libtiff-${version}.tar.gz`,
          url: `https://download.osgeo.org/libtiff/tiff-${version}.tar.gz`,
        },
  uhdr: (version, context) =>
    isCommitToken(version)
      ? gitArchiveSpec(
          "libultrahdr",
          "https://github.com/google/libultrahdr.git",
          "https://github.com/google/libultrahdr/commit",
          context.commit("uhdr", version),
        )
      : {
          fileName: `libultrahdr-${version}.tar.gz`,
          url: `https://github.com/google/libultrahdr/archive/refs/tags/v${version}.tar.gz`,
        },
  vips: (version) => ({
    fileName: `vips-${version}.tar.xz`,
    url: `https://github.com/libvips/libvips/releases/download/v${version}/vips-${version}.tar.xz`,
  }),
  webp: (version) => ({
    fileName: `libwebp-${version}.tar.gz`,
    url:
      "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/" +
      `libwebp-${version}.tar.gz`,
  }),
  xml2: (version) => ({
    fileName: `libxml2-${version}.tar.xz`,
    url:
      `https://download.gnome.org/sources/libxml2/${withoutPatch(version)}/` +
      `libxml2-${version}.tar.xz`,
  }),
  "zlib-ng": (version) => ({
    fileName: `zlib-ng-${version}.tar.gz`,
    url: `https://github.com/zlib-ng/zlib-ng/archive/refs/tags/${version}.tar.gz`,
  }),
};

export function isLicenseFileName(name) {
  return licenseFilePattern.test(name);
}

export async function hasExpectedFileHeader(fileName, file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    const lowerText = header.toString("utf8").trimStart().toLowerCase();
    if (lowerText.startsWith("<!doctype html") || lowerText.startsWith("<html")) {
      return false;
    }
    if (fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz")) {
      return header[0] === 0x1f && header[1] === 0x8b;
    }
    if (fileName.endsWith(".tar.xz")) {
      return header.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]));
    }
    if (fileName.endsWith(".tar")) {
      return header.subarray(257, 262).toString("ascii") === "ustar";
    }
    if (fileName.endsWith(".zip")) {
      return header[0] === 0x50 && header[1] === 0x4b;
    }
    return bytesRead >= 100;
  } finally {
    await handle.close();
  }
}

export function onnxRefForVersion(version, policy) {
  const configured = policy.onnxruntime?.[version];
  if (configured) return configured;
  throw new Error(
    `ONNX Runtime ${version} has not been reviewed. Add its exact source ref to ` +
      "third_party/compliance-policy.json.",
  );
}

export function reviewedMaterialHash(id, hashes, kind) {
  const hash = hashes?.[id];
  if (/^[a-f0-9]{64}$/.test(hash ?? "")) return hash;
  throw new Error(
    `${kind} ${id} has no reviewed SHA-256. Add it to third_party/compliance-policy.json.`,
  );
}

export function findPackageLicenseFiles(root) {
  const matches = [];
  function visit(directory, relativeDirectory = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && isLicenseFileName(entry.name)) {
        matches.push(relative);
      }
    }
  }
  visit(root);
  return matches.sort((a, b) => a.localeCompare(b));
}

export function buildNativeSourceSpecs(
  versions,
  {
    platform,
    sharpVersion,
    sharpLibvipsVersion,
    electronVersion,
    ffmpegRevision,
    sourceCommits,
  },
) {
  const context = {
    commit: (component, version) => resolveReviewedCommit(component, version, sourceCommits),
  };
  const specs = [];
  // Only the components actually present in the selected payload's versions.json are
  // required, and every one of them must have a reviewed source builder.
  for (const [name, version] of Object.entries(versions ?? {})) {
    const builder = sourceBuilders[name];
    if (!builder) {
      throw new Error(
        `Sharp native payload component "${name}" (${version}) has no reviewed source ` +
          "builder. Review its upstream source and add one to scripts/compliance.mjs.",
      );
    }
    if (!version) {
      throw new Error(`Sharp native payload does not identify a ${name} version.`);
    }
    specs.push({
      id: `sharp-native-${name}@${version}`,
      component: name,
      version,
      reason: "Source and license material for the Sharp/libvips native payload.",
      ...builder(version, context),
    });
  }

  specs.push(
    {
      id: "sharp",
      version: sharpVersion,
      fileName: `sharp-${sharpVersion}.tar.gz`,
      url: `https://github.com/lovell/sharp/archive/refs/tags/v${sharpVersion}.tar.gz`,
      reason: "Source for the Sharp native Node.js binding.",
    },
    {
      id: "sharp-libvips-build",
      version: sharpLibvipsVersion,
      fileName: `sharp-libvips-${sharpLibvipsVersion}.tar.gz`,
      url:
        "https://github.com/lovell/sharp-libvips/archive/refs/tags/" +
        `v${sharpLibvipsVersion}.tar.gz`,
      reason: "Build scripts and packaging instructions for the libvips payload.",
    },
    {
      id: "electron",
      version: electronVersion,
      fileName: `electron-${electronVersion}.tar.gz`,
      url:
        "https://github.com/electron/electron/archive/refs/tags/" +
        `v${electronVersion}.tar.gz`,
      reason: "Electron source, including its FFmpeg patch queue and build integration.",
    },
    {
      id: "electron-ffmpeg",
      version: ffmpegRevision,
      fileName: `electron-ffmpeg-${ffmpegRevision}.tar`,
      url:
        "https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/" +
        ffmpegRevision,
      gitRepository:
        "https://chromium.googlesource.com/chromium/third_party/ffmpeg",
      gitRevision: ffmpegRevision,
      archivePrefix: `electron-ffmpeg-${ffmpegRevision}/`,
      reason: "Corresponding source for Electron's dynamically loaded LGPL FFmpeg library.",
    },
    {
      id: "electron-ffmpeg-patch-link-with-loader-path",
      version: electronVersion,
      fileName: "electron-ffmpeg-link-with-loader-path.patch",
      url:
        "https://raw.githubusercontent.com/electron/electron/" +
        `v${electronVersion}/patches/ffmpeg/link_with_loader_path.patch`,
      reason: "Patch Electron applies to its pinned FFmpeg source.",
    },
  );

  if (platform === "win32") {
    // The Windows payload is repackaged from a libvips/build-win64-mxe release, whose
    // build scripts and every applied patch live inside this archive.
    specs.push({
      id: "libvips-windows-build",
      version: versions.vips,
      fileName: `build-win64-mxe-${versions.vips}.tar.gz`,
      url:
        "https://github.com/libvips/build-win64-mxe/archive/refs/tags/" +
        `v${versions.vips}.tar.gz`,
      reason: "Windows build scripts and patches for the libvips payload.",
    });
  } else {
    // Patches that sharp-libvips fetches from outside its own repository while building
    // the POSIX payload. Windows applies its patches from the in-repo archive above.
    specs.push(
      {
        id: "sharp-patch-glib-without-gregex",
        version: "bdad5489a61c217850631571caf57f5db6ea8b2c",
        fileName: "glib-without-gregex.patch",
        url:
          "https://gist.github.com/kleisauke/284d685efa00908da99ea6afbaaf39ae/raw/" +
          "bdad5489a61c217850631571caf57f5db6ea8b2c/glib-without-gregex.patch",
        reason: "Patch applied by the Sharp/libvips POSIX build.",
      },
      {
        id: "sharp-patch-mozjpeg-simd-fdct",
        version: "f90668e0e4fb79c81e1f24a0ccc0e2090af761bf",
        fileName: "mozjpeg-saturating-simd-fdct.patch",
        url:
          "https://github.com/mozilla/mozjpeg/commit/" +
          "f90668e0e4fb79c81e1f24a0ccc0e2090af761bf.patch",
        reason: "Patch applied by the Sharp/libvips POSIX build.",
      },
      {
        // sharp-libvips fetches this as the mutable pull/383.patch; it is pinned here to
        // the pull request's single immutable commit.
        id: "sharp-patch-uhdr-platform-detection",
        version: "e2daed8da97d8857dcec2fd68d2f6f3326170f67",
        fileName: "libultrahdr-remove-platform-detection.patch",
        url:
          "https://github.com/google/libultrahdr/commit/" +
          "e2daed8da97d8857dcec2fd68d2f6f3326170f67.patch",
        reason: "Patch applied by the Sharp/libvips POSIX build.",
      },
      {
        id: "sharp-patch-libvips-soversion",
        version: "3988223c7dfa4d22745d9392034b0117abef1446",
        fileName: "libvips-cpp-soversion.patch",
        url:
          "https://gist.githubusercontent.com/lovell/313a6901e9db1bf285f2a1f1180499e4/raw/" +
          "3988223c7dfa4d22745d9392034b0117abef1446/libvips-cpp-soversion.patch",
        reason: "Patch applied by the Sharp/libvips POSIX build.",
      },
    );
  }

  return specs.sort((a, b) => a.id.localeCompare(b.id));
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(
      `${label} differ from the reviewed set; expected ${sortedExpected.join(", ")}, ` +
        `found ${actual.join(", ") || "(none)"}.`,
    );
  }
}

function reviewedTesseractSourceRevisions(tesseract) {
  const expected = Object.keys(tesseractCoreSources);
  assertExactKeys(tesseract?.sourceRevisions, expected, "Tesseract source revisions");
  for (const [name, revision] of Object.entries(tesseract.sourceRevisions)) {
    if (!/^[a-f0-9]{40}$/.test(revision)) {
      throw new Error(`Tesseract ${name} source revision must be a full Git commit.`);
    }
  }
  return tesseract.sourceRevisions;
}

export function buildTesseractSourceSpecs(tesseract) {
  if (!/^\d+\.\d+\.\d+$/.test(tesseract?.coreVersion ?? "")) {
    throw new Error("Tesseract.js-core must have a reviewed exact version.");
  }
  const revisions = reviewedTesseractSourceRevisions(tesseract);
  return Object.entries(tesseractCoreSources)
    .map(([name, source]) => {
      const revision = revisions[name];
      const isCore = name === "core";
      return {
        id: isCore
          ? `tesseract-js-core@${tesseract.coreVersion}`
          : `tesseract-core-${name}@${revision}`,
        version: isCore ? tesseract.coreVersion : revision,
        fileName: `${source.archiveName}-${revision}.tar`,
        url: `${source.webBase}/${revision}`,
        gitRepository: source.gitRepository,
        gitRevision: revision,
        archivePrefix: `${source.archiveName}-${revision}/`,
        reason: isCore
          ? "Build scripts and source for the packaged Tesseract WebAssembly runtime."
          : `Source and license material for ${name}, statically linked into Tesseract WebAssembly.`,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function packageNameFromLockPath(lockPath) {
  return lockPath.split("node_modules/").at(-1);
}

export function buildArtisticSourceSpecs(lock, reviewedPackages) {
  const installed = new Map();
  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    if (!lockPath || entry.dev || entry.license !== "Artistic-2.0") continue;
    const name = packageNameFromLockPath(lockPath);
    const versions = installed.get(name) ?? new Set();
    versions.add(entry.version);
    installed.set(name, versions);
  }

  assertExactKeys(
    Object.fromEntries(installed),
    Object.keys(reviewedPackages ?? {}),
    "Artistic-2.0 packages",
  );
  return Object.entries(reviewedPackages ?? {})
    .map(([name, version]) => {
      const versions = installed.get(name);
      if (versions?.size !== 1 || !versions.has(version)) {
        throw new Error(
          `${name} Artistic-2.0 versions have not been reviewed: ` +
            `${[...(versions ?? [])].join(", ") || "(missing)"}; expected ${version}.`,
        );
      }
      if (name.includes("/")) {
        throw new Error(`Scoped Artistic-2.0 package ${name} needs an explicit source URL.`);
      }
      return {
        id: `npm-source-${name}@${version}`,
        version,
        fileName: `${name}-${version}.tgz`,
        url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        reason:
          "Verbatim Standard Version source for an Artistic-2.0 package distributed with the app.",
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildComplianceSourceSpecs(nativeVersions, lock, policy, platform) {
  return [
    ...buildNativeSourceSpecs(nativeVersions, {
      platform,
      sharpVersion: policy.sharp,
      sharpLibvipsVersion: policy.sharpLibvips.version,
      electronVersion: policy.electron.version,
      ffmpegRevision: policy.electron.ffmpegRevision,
      sourceCommits: policy.sourceCommits,
    }),
    ...buildTesseractSourceSpecs(policy.tesseract),
    ...buildArtisticSourceSpecs(lock, policy.artisticPackages),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildTesseractNoticeSpecs(tesseract) {
  const revisions = reviewedTesseractSourceRevisions(tesseract);
  const specs = Object.entries(tesseractCoreNoticeFiles).map(([name, notice]) => {
    const source = tesseractCoreSources[name];
    const revision = revisions[name];
    return {
      id: `tesseract-core-${name}-license`,
      fileName: `tesseract-core-${notice.outputFile}`,
      outputPath: `tesseract-core/${notice.outputFile}`,
      url: `${source.rawBase}/${revision}/${notice.path}`,
      marker: notice.marker,
    };
  });

  const tessdataRevision = tesseract?.tessdata?.revision;
  if (!/^[a-f0-9]{40}$/.test(tessdataRevision ?? "")) {
    throw new Error("Tesseract tessdata revision must be a full Git commit.");
  }
  specs.push({
    id: "tessdata-fast-license",
    fileName: "tessdata-fast-LICENSE.txt",
    outputPath: "tesseract-core/tessdata-fast-LICENSE.txt",
    url:
      `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/` +
      `${tessdataRevision}/LICENSE`,
    marker: "Apache License",
  });
  return specs.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildStaticRemoteMaterialSpecs(policy) {
  return [
    ...legalTextSpecs.map((spec) => ({
      ...spec,
      outputPath: `licenses/${spec.fileName}`,
    })),
    ...buildTesseractNoticeSpecs(policy.tesseract),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export function assertReviewedTessdataPins(source, tessdata) {
  const revision = source.match(/export const TESSDATA_COMMIT = "([a-f0-9]{40})"/)?.[1];
  if (revision !== tessdata?.revision) {
    throw new Error(
      `Runtime tessdata revision ${revision ?? "(missing)"} has not been reviewed; ` +
        `expected ${tessdata?.revision ?? "(missing)"}.`,
    );
  }

  const block = source.match(/export const TESSDATA_SHA256:[\s\S]*?=\s*\{([\s\S]*?)\};/)?.[1];
  if (!block) throw new Error("Runtime tessdata SHA-256 map could not be read.");
  const runtimeFiles = Object.fromEntries(
    [...block.matchAll(/^\s*([A-Za-z0-9_-]+):\s*"([a-f0-9]{64})",?\s*$/gm)].map(
      ([, name, sha256]) => [`${name}.traineddata`, sha256],
    ),
  );
  assertExactKeys(runtimeFiles, Object.keys(tessdata.files ?? {}), "Tessdata files");
  for (const [name, sha256] of Object.entries(tessdata.files ?? {})) {
    if (runtimeFiles[name] !== sha256) {
      throw new Error(`Runtime tessdata hash for ${name} does not match the reviewed policy.`);
    }
  }
}

export async function prepareCompliance({
  rootDir = repositoryRoot,
  outputDir = complianceOutput,
  includeSources = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required.");

  const policy = readJson(path.join(rootDir, "third_party", "compliance-policy.json"));
  const lock = readJson(path.join(rootDir, "package-lock.json"));
  const manifest = readJson(path.join(rootDir, "package.json"));
  const target = `${process.platform}-${process.arch}`;
  assertWasmExcludedFromPackaging(manifest.build);
  assertLockfileClosure(lock);
  if (includeSources && !releaseTargets.includes(target)) {
    throw new Error(
      `${target} is not a supported release target (${releaseTargets.join(", ")}). Run ` +
        "compliance:licenses instead of preparing a redistributable bundle.",
    );
  }
  const packages = collectProductionPackages(rootDir, lock);
  validateReviewedVersions(packages, lock, policy, rootDir);
  await removeStalePartialFiles(path.join(rootDir, ".compliance-cache"));

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await Promise.all([
    copyFile(path.join(rootDir, "LICENSE"), path.join(outputDir, "LICENSE")),
    copyFile(
      path.join(rootDir, "THIRD-PARTY-NOTICES.md"),
      path.join(outputDir, "THIRD-PARTY-NOTICES.md"),
    ),
  ]);

  const inventory = buildLicenseInventory(rootDir, packages, policy);
  await writeFile(
    path.join(outputDir, "THIRD-PARTY-LICENSES.txt"),
    renderLicenseInventory(inventory, lock, rootDir),
    "utf8",
  );
  await writeJson(path.join(outputDir, "LICENSE-INVENTORY.json"), {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    packageLockSha256: sha256FileSync(path.join(rootDir, "package-lock.json")),
    packages: inventory.map(({ text: _text, ...entry }) => entry),
    unresolved: [],
  });

  const native = collectNativeComponents(packages, lock, {
    platform: process.platform,
    arch: process.arch,
  });
  await writeFile(
    path.join(outputDir, "NATIVE-THIRD-PARTY-NOTICES.md"),
    native.notices,
    "utf8",
  );
  await writeJson(path.join(outputDir, "NATIVE-COMPONENTS.json"), {
    schemaVersion: 2,
    platform: process.platform,
    architecture: process.arch,
    releaseTarget: releaseTargets.includes(target),
    excludedFromArtifacts: excludedWasmPackages,
    packages: native.packages,
    versions: native.versions,
  });

  const remoteMaterials = await prepareRemoteMaterials({
    outputDir,
    rootDir,
    packages,
    policy,
    fetchImpl,
  });
  await writeJson(path.join(outputDir, "REMOTE-MATERIALS.json"), {
    schemaVersion: 1,
    materials: remoteMaterials,
  });

  const sourceManifest = includeSources
    ? await prepareSources({
        outputDir,
        rootDir,
        policy,
        lock,
        nativeVersions: native.versions,
        fetchImpl,
      })
    : { schemaVersion: 1, mode: "licenses-only", sources: [] };
  await writeJson(path.join(outputDir, "SOURCE-MANIFEST.json"), sourceManifest);
  if (includeSources) {
    await prepareElectronNotices({ outputDir, rootDir, policy, fetchImpl });
  }

  await writeFile(
    path.join(outputDir, "RELINKING.md"),
    renderRelinking(native, sourceManifest, policy, process.platform),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "COMPLIANCE-README.md"),
    renderComplianceReadme(includeSources),
    "utf8",
  );

  await verifyComplianceDirectory(outputDir, {
    requireSources: includeSources,
    requireElectronNotices: includeSources,
  });
  return {
    packageCount: inventory.length,
    sourceCount: sourceManifest.sources.length,
    outputDir,
  };
}

export async function verifyComplianceDirectory(
  directory,
  {
    requireSources = true,
    requireElectronNotices = false,
    requireRemoteMaterials = true,
  } = {},
) {
  const policy = readJson(policyPath);
  for (const file of requiredComplianceFiles) {
    const target = path.join(directory, file);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`Compliance bundle is missing ${file}.`);
    }
  }

  const inventory = readJson(path.join(directory, "LICENSE-INVENTORY.json"));
  if (!Array.isArray(inventory.packages) || inventory.packages.length === 0) {
    throw new Error("Compliance license inventory is empty.");
  }
  if (!Array.isArray(inventory.unresolved) || inventory.unresolved.length !== 0) {
    throw new Error(`Compliance inventory has unresolved licenses: ${inventory.unresolved}`);
  }

  const licenseText = await readFile(
    path.join(directory, "THIRD-PARTY-LICENSES.txt"),
    "utf8",
  );
  if (licenseText.length < 1_000) {
    throw new Error("Generated third-party license text is unexpectedly short.");
  }

  const remote = readJson(path.join(directory, "REMOTE-MATERIALS.json"));
  if (requireRemoteMaterials) {
    assertExactManifestIds(
      remote.materials,
      Object.keys(policy.remoteMaterials),
      "remote materials",
    );
  }
  for (const material of remote.materials ?? []) {
    if (
      requireRemoteMaterials &&
      material.sha256 !==
        reviewedMaterialHash(material.id, policy.remoteMaterials, "Remote material")
    ) {
      throw new Error(`Remote material ${material.id} does not match its reviewed SHA-256.`);
    }
    await verifyManifestFile(directory, material);
  }

  const sources = readJson(path.join(directory, "SOURCE-MANIFEST.json"));
  if (requireSources && sources.mode !== "full") {
    throw new Error("Release compliance requires full corresponding sources.");
  }
  if (requireSources && (!Array.isArray(sources.sources) || sources.sources.length < 30)) {
    throw new Error("Corresponding-source manifest is incomplete.");
  }
  if (requireSources) {
    const native = readJson(path.join(directory, "NATIVE-COMPONENTS.json"));
    const lock = readJson(path.join(repositoryRoot, "package-lock.json"));
    const expectedSources = buildComplianceSourceSpecs(
      native.versions,
      lock,
      policy,
      native.platform,
    );
    assertExactManifestIds(
      sources.sources,
      expectedSources.map(({ id }) => id),
      "corresponding sources",
    );
  }
  for (const source of sources.sources ?? []) {
    if (
      requireSources &&
      source.sha256 !==
        reviewedMaterialHash(source.id, policy.sourceMaterials, "Source material")
    ) {
      throw new Error(`Source material ${source.id} does not match its reviewed SHA-256.`);
    }
    await verifyManifestFile(directory, source);
  }

  if (requireElectronNotices) {
    const electron = readJson(path.join(directory, "ELECTRON-NOTICES.json"));
    const distributionKey = `${electron.platform}-${electron.architecture}`;
    const expectedDistributionHash = reviewedMaterialHash(
      distributionKey,
      policy.electron?.distributions,
      "Electron distribution",
    );
    if (
      electron.version !== policy.electron?.version ||
      electron.archive?.sha256 !== expectedDistributionHash
    ) {
      throw new Error("Electron notice archive does not match the reviewed distribution.");
    }
    for (const notice of electron.notices ?? []) {
      const noticeName = path.posix.basename(notice.file);
      const reviewed = reviewedMaterialHash(
        noticeName,
        policy.electron?.notices?.[distributionKey],
        `Electron ${distributionKey} notice`,
      );
      if (notice.sha256 !== reviewed) {
        throw new Error(
          `Electron notice ${noticeName} does not match its reviewed SHA-256 for ` +
            `${distributionKey}.`,
        );
      }
      await verifyManifestFile(directory, notice);
    }
    if (electron.notices?.length !== 2) {
      throw new Error("Packaged compliance bundle must contain both Electron notices.");
    }
  }

  return {
    packageCount: inventory.packages.length,
    sourceCount: sources.sources?.length ?? 0,
  };
}

async function verifyManifestFile(directory, entry) {
  const normalizedFile =
    typeof entry.file === "string" ? entry.file.replaceAll("\\", "/") : entry.file;
  if (
    typeof normalizedFile !== "string" ||
    path.isAbsolute(normalizedFile) ||
    normalizedFile.split("/").includes("..")
  ) {
    throw new Error(`Compliance manifest contains unsafe path ${entry.file}.`);
  }
  const target = path.join(directory, ...normalizedFile.split("/"));
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`Compliance material is missing ${entry.file}.`);
  }
  const actual = await sha256File(target);
  if (actual !== entry.sha256) {
    throw new Error(
      `Compliance material ${entry.file} has SHA-256 ${actual}, expected ${entry.sha256}.`,
    );
  }
}

function assertExactManifestIds(entries, expectedIds, label) {
  const actual = [...new Set((entries ?? []).map(({ id }) => id))].sort();
  const expected = [...new Set(expectedIds)].sort();
  if (
    (entries?.length ?? 0) !== actual.length ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `Compliance ${label} differ from policy; expected ${expected.join(", ")}, ` +
        `found ${actual.join(", ")}.`,
    );
  }
}

function collectProductionPackages(rootDir, lock) {
  const packages = [];
  for (const [lockPath, lockEntry] of Object.entries(lock.packages ?? {})) {
    if (!lockPath || lockEntry.dev) continue;
    const directory = path.join(rootDir, ...lockPath.split("/"));
    const packageJsonPath = path.join(directory, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const metadata = readJson(packageJsonPath);
    packages.push({
      directory,
      lockPath,
      metadata,
      name: metadata.name,
      version: metadata.version ?? lockEntry.version,
      license: normalizeLicense(metadata.license ?? lockEntry.license),
    });
  }
  return packages.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version) ||
      a.lockPath.localeCompare(b.lockPath),
  );
}

function validateReviewedVersions(packages, lock, policy, rootDir) {
  assertInstalledVersion(packages, "@github/copilot-sdk", policy.copilotSdk);
  assertReviewedCopilotCliVersions(lock, policy.copilotCli);
  assertInstalledVersion(packages, "sharp", policy.sharp);
  for (const name of [
    "@secretlint/core",
    "@secretlint/secretlint-rule-pattern",
    "@secretlint/secretlint-rule-preset-recommend",
  ]) {
    assertInstalledVersion(packages, name, policy.secretlint);
  }
  assertInstalledVersion(packages, "tesseract.js", policy.tesseract.jsVersion);
  assertInstalledVersion(packages, "tesseract.js-core", policy.tesseract.coreVersion);
  buildArtisticSourceSpecs(lock, policy.artisticPackages);
  assertReviewedTessdataPins(
    readFileSync(path.join(rootDir, "electron", "sensitive", "tessdata-source.ts"), "utf8"),
    policy.tesseract.tessdata,
  );

  const electronVersion = lock.packages?.["node_modules/electron"]?.version;
  if (electronVersion !== policy.electron.version) {
    throw new Error(
      `Electron ${electronVersion} has not been reviewed; expected ${policy.electron.version}.`,
    );
  }

  const sharpLibvipsVersions = new Set(
    Object.entries(lock.packages ?? {})
      .filter(([lockPath]) => lockPath.startsWith("node_modules/@img/sharp-libvips-"))
      .map(([, entry]) => entry.version),
  );
  if (
    sharpLibvipsVersions.size !== 1 ||
    !sharpLibvipsVersions.has(policy.sharpLibvips.version)
  ) {
    throw new Error(
      `Sharp/libvips package versions have not been reviewed: ${[
        ...sharpLibvipsVersions,
      ].join(", ")}.`,
    );
  }

  for (const pkg of packages.filter(({ name }) => name.startsWith("onnxruntime-"))) {
    onnxRefForVersion(pkg.version, policy);
  }
}

export function assertReviewedCopilotCliVersions(lock, expected) {
  const versions = new Set(
    Object.entries(lock.packages ?? {})
      .filter(
        ([lockPath]) =>
          lockPath === "node_modules/@github/copilot" ||
          /^node_modules\/@github\/copilot-(?:darwin|linux|linuxmusl|win32)-/.test(
            lockPath,
          ),
      )
      .map(([, entry]) => entry.version),
  );
  if (versions.size !== 1 || !versions.has(expected)) {
    throw new Error(
      `GitHub Copilot CLI versions have not been reviewed: ${
        [...versions].join(", ") || "(missing)"
      }; expected ${expected}.`,
    );
  }
}

function assertInstalledVersion(packages, name, expected) {
  const versions = new Set(packages.filter((pkg) => pkg.name === name).map((pkg) => pkg.version));
  if (versions.size !== 1 || !versions.has(expected)) {
    throw new Error(
      `${name} versions have not been reviewed: ${[...versions].join(", ") || "(missing)"}; ` +
        `expected ${expected}.`,
    );
  }
}

function buildLicenseInventory(rootDir, packages, policy) {
  return packages.map((pkg) => {
    const files = findPackageLicenseFiles(pkg.directory);

    // Sharp's platform packages declare compound SPDX expressions but ship at most the
    // permissive half, so they are resolved term by term before the file-based path.
    if (pkg.name.startsWith("@img/sharp-")) {
      return reviewedSharpLicenseEntry(pkg, policy, files);
    }

    if (pkg.license === "Artistic-2.0") {
      if (files.length === 0) {
        throw new Error(`${pkg.name}@${pkg.version} is missing its Artistic-2.0 notice.`);
      }
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        packagePath: pkg.lockPath,
        licenseSource: `${files.join(", ")}, licenses/Artistic-2.0.txt`,
        text: [
          ...files.map(
            (file) =>
              `----- ${file} -----\n${readFileSync(
                path.join(pkg.directory, ...file.split("/")),
                "utf8",
              ).trim()}`,
          ),
          "The complete Artistic License 2.0 accompanies this application at " +
            "licenses/Artistic-2.0.txt. Verbatim package source is listed in " +
            "SOURCE-MANIFEST.json for redistributable builds.",
        ].join("\n\n"),
      };
    }

    if (files.length > 0) {
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        packagePath: pkg.lockPath,
        licenseSource: files.join(", "),
        text: files
          .map(
            (file) =>
              `----- ${file} -----\n${readFileSync(
                path.join(pkg.directory, ...file.split("/")),
                "utf8",
              ).trim()}`,
          )
          .join("\n\n"),
      };
    }

    if (pkg.name === "@koromix/koffi-win32-arm64" || pkg.name === "@koromix/koffi-win32-x64") {
      const parent = path.join(rootDir, "node_modules", "koffi", "LICENSE.txt");
      if (!existsSync(parent)) throw new Error(`${pkg.name} requires the parent Koffi license.`);
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        packagePath: pkg.lockPath,
        licenseSource: "koffi/LICENSE.txt",
        text: readFileSync(parent, "utf8").trim(),
      };
    }

    if (pkg.name === "@github/copilot-sdk") {
      if (pkg.version !== policy.copilotSdk) {
        throw new Error(`No reviewed Copilot SDK license override exists for ${pkg.version}.`);
      }
      return overrideEntry(
        pkg,
        path.join(rootDir, "third_party", "package-licenses", "github-copilot-sdk-MIT.txt"),
      );
    }

    if (pkg.name.startsWith("onnxruntime-")) {
      onnxRefForVersion(pkg.version, policy);
      return overrideEntry(
        pkg,
        path.join(rootDir, "third_party", "package-licenses", "onnxruntime-MIT.txt"),
      );
    }

    if (pkg.license === "MIT") {
      return metadataLicenseEntry(pkg, renderMitFallback(pkg));
    }
    if (pkg.license === "ISC") {
      return metadataLicenseEntry(pkg, renderIscFallback(pkg));
    }

    throw new Error(
      `${pkg.name}@${pkg.version} declares ${pkg.license} but has no license file or reviewed override.`,
    );
  });
}

/** Splits an SPDX expression such as `A AND B AND C` into its individual terms. */
export function splitSpdxAnd(license) {
  const expression = String(license ?? "").trim().replace(/^\((.*)\)$/s, "$1");
  return expression
    .split(/\s+AND\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

const lgplPointerText = [
  "This platform package contains the libvips runtime under LGPL-3.0-or-later.",
  "The complete canonical LGPL-3.0 text accompanies the generated compliance",
  "bundle at licenses/LGPL-3.0.txt. Native dependency notices and corresponding",
  "source are identified separately in the same bundle.",
].join("\n");

const canonicalMitText = [
  "MIT License",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
].join("\n");

/**
 * Resolves every term of a Sharp platform package's SPDX expression to concrete license
 * text, failing closed when a declared term has no reviewed material.
 */
export function reviewedSharpLicenseEntry(pkg, policy, files = []) {
  const isLibvips = pkg.name.startsWith("@img/sharp-libvips");
  const expectedVersion = isLibvips ? policy.sharpLibvips.version : policy.sharp;
  if (pkg.version !== expectedVersion) {
    throw new Error(
      isLibvips
        ? `No reviewed Sharp/libvips license override exists for ${pkg.version}.`
        : `No reviewed Sharp license override exists for ${pkg.name}@${pkg.version}.`,
    );
  }

  const terms = splitSpdxAnd(pkg.license);
  if (terms.length === 0) {
    throw new Error(`${pkg.name}@${pkg.version} declares no license metadata.`);
  }

  const shipped = files.map((file) => ({
    file,
    text: readFileSync(path.join(pkg.directory, ...file.split("/")), "utf8").trim(),
  }));
  const sections = [];
  const sources = [];

  for (const term of terms) {
    if (term === "Apache-2.0") {
      const match = shipped.find(({ text }) => text.includes("Apache License"));
      if (!match) {
        throw new Error(
          `${pkg.name}@${pkg.version} declares Apache-2.0 but ships no Apache license text.`,
        );
      }
      sections.push(`----- Apache-2.0 (${match.file}) -----\n${match.text}`);
      sources.push(match.file);
    } else if (term === "LGPL-3.0-or-later") {
      sections.push(lgplPointerText);
      sources.push("licenses/LGPL-3.0.txt");
    } else if (term === "MIT") {
      sections.push(`----- MIT -----\n${canonicalMitText}`);
      sources.push("canonical SPDX MIT text");
    } else {
      throw new Error(
        `${pkg.name}@${pkg.version} has unexpected license metadata: ${pkg.license}.`,
      );
    }
  }

  return {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    packagePath: pkg.lockPath,
    licenseSource: sources.join(", "),
    text: sections.join("\n\n"),
  };
}

/** @deprecated Retained as the libvips-specific entry point into {@link reviewedSharpLicenseEntry}. */
export function reviewedSharpLibvipsLicenseEntry(pkg, policy, files = []) {
  return reviewedSharpLicenseEntry(pkg, policy, files);
}

function overrideEntry(pkg, file) {
  if (!existsSync(file)) throw new Error(`Missing reviewed license override ${file}.`);
  return {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    packagePath: pkg.lockPath,
    licenseSource: path.relative(repositoryRoot, file).replaceAll("\\", "/"),
    text: readFileSync(file, "utf8").trim(),
  };
}

function metadataLicenseEntry(pkg, text) {
  return {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    packagePath: pkg.lockPath,
    licenseSource: "package.json declaration plus canonical SPDX text",
    text,
  };
}

function renderLicenseInventory(inventory, lock, rootDir) {
  const packageLockHash = sha256FileSync(path.join(rootDir, "package-lock.json"));
  const blocks = inventory.map(
    (entry) =>
      [
        "=".repeat(80),
        `${entry.name}@${entry.version}`,
        `Declared license: ${entry.license}`,
        `Installed path: ${entry.packagePath}`,
        `License material: ${entry.licenseSource}`,
        "-".repeat(80),
        entry.text,
      ].join("\n"),
  );
  return [
    "SKILL RECORDER THIRD-PARTY LICENSES",
    "",
    "These terms apply to the identified third-party components, not to Skill",
    "Recorder's own MIT-licensed code.",
    "",
    `Platform: ${process.platform}-${process.arch}`,
    `package-lock.json SHA-256: ${packageLockHash}`,
    `Lockfile version: ${lock.lockfileVersion}`,
    "",
    ...blocks,
    "",
  ].join("\n");
}

/**
 * Selects the one native payload package that is actually packaged for a platform and
 * architecture, and fails closed on anything unexpected.
 */
export function selectNativePayload(
  packages,
  { platform = process.platform, arch = process.arch, libc } = {},
) {
  const target = `${platform}-${arch}`;
  const expected = nativePayloadCandidates[target];
  if (!expected) {
    throw new Error(
      `${target} is not a reviewed Sharp native platform. Add it to nativePayloadCandidates ` +
        "or remove it as a distribution target.",
    );
  }

  const installed = packages.filter(
    ({ name, directory }) =>
      name.startsWith("@img/sharp-") && existsSync(path.join(directory, "versions.json")),
  );
  const unexpected = installed.filter(
    ({ name }) => !expected.includes(name) && !excludedWasmPackages.includes(name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected Sharp native payload installed for ${target}: ` +
        `${unexpected.map(({ name }) => name).join(", ")}.`,
    );
  }

  let selected = installed.filter(({ name }) => expected.includes(name));
  if (selected.length > 1 && platform === "linux") {
    const wantsMusl = (libc ?? detectLinuxLibc()) === "musl";
    selected = selected.filter(({ name }) => name.includes("-linuxmusl-") === wantsMusl);
  }
  if (selected.length === 0) {
    throw new Error(
      `No Sharp native payload is installed for ${target}; expected ${expected.join(" or ")}.`,
    );
  }
  if (selected.length > 1) {
    throw new Error(
      `More than one distributable Sharp native payload is installed for ${target}: ` +
        `${selected.map(({ name }) => name).join(", ")}.`,
    );
  }

  const payload = selected[0];
  if (!payload.name.endsWith(`-${arch}`)) {
    throw new Error(`Sharp native payload ${payload.name} does not target ${arch}.`);
  }
  return payload;
}

/**
 * The WASM payload may only be ignored as a native input while every Electron artifact
 * explicitly excludes it; otherwise it would ship without static-LGPL treatment.
 */
export function assertWasmExcludedFromPackaging(buildConfig) {
  const fileLists = [
    ["files", buildConfig?.files],
    ["win.files", buildConfig?.win?.files],
    ["mac.files", buildConfig?.mac?.files],
    ["linux.files", buildConfig?.linux?.files],
  ].filter(([, list]) => list !== undefined);
  if (!Array.isArray(buildConfig?.files)) {
    throw new Error("Electron Builder configuration must declare a global build.files list.");
  }
  for (const [label, list] of fileLists) {
    if (!Array.isArray(list)) {
      throw new Error(`Electron Builder configuration ${label} must be an array.`);
    }
    for (const name of excludedWasmPackages) {
      if (!list.includes(`!node_modules/${name}/**`)) {
        throw new Error(
          `Electron Builder ${label} does not exclude ${name}; the unused WASM payload would ` +
            "be distributed without corresponding source and notices.",
        );
      }
    }
  }
}

/**
 * `npm install` on Windows can silently drop entries that only other platforms need,
 * which leaves a lockfile that fails `npm ci` on Linux and macOS. The documented
 * source-install path depends on `npm ci`, so an incomplete lockfile is a release
 * blocker rather than an inconvenience.
 */
export function assertLockfileClosure(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("package-lock.json must declare a packages map.");
  }

  const resolveFrom = (from, dependency) => {
    let current = from;
    for (;;) {
      const candidate =
        current === "" ? `node_modules/${dependency}` : `${current}/node_modules/${dependency}`;
      if (candidate in packages) return candidate;
      const boundary = current.lastIndexOf("/node_modules/");
      if (boundary === -1) {
        if (current === "") return null;
        current = "";
      } else {
        current = current.slice(0, boundary);
      }
    }
  };

  const gaps = [];
  for (const [from, entry] of Object.entries(packages)) {
    const required = { ...entry?.dependencies, ...entry?.optionalDependencies };
    for (const dependency of Object.keys(required)) {
      if (!resolveFrom(from, dependency)) {
        gaps.push(`${from || "<root>"} -> ${dependency}`);
      }
    }
  }

  if (gaps.length > 0) {
    throw new Error(
      "package-lock.json is missing entries that npm ci needs on other platforms: " +
        `${gaps.join(", ")}. Regenerate it with an empty node_modules directory.`,
    );
  }
}

function nativePayloadBinaries(directory) {
  const binaries = [];
  function visit(current, relative = "") {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(current, entry.name), next);
      } else if (entry.isFile() && nativeBinaryPattern.test(entry.name)) {
        const file = path.join(current, entry.name);
        binaries.push({ file: next, sha256: sha256FileSync(file), bytes: statSync(file).size });
      }
    }
  }
  visit(directory);
  return binaries.sort((a, b) => a.file.localeCompare(b.file));
}

function collectNativeComponents(packages, lock, { platform, arch }) {
  const payload = selectNativePayload(packages, { platform, arch });
  const versionsFile = path.join(payload.directory, "versions.json");
  const versions = readJson(versionsFile);

  const readme = path.join(payload.directory, "README.md");
  if (!existsSync(readme)) {
    throw new Error(`${payload.name}@${payload.version} is missing its native licensing README.`);
  }
  const notices = readFileSync(readme, "utf8").trim();
  if (!notices.includes("third-party libraries") || !notices.includes("LGPL")) {
    throw new Error(`${payload.name}@${payload.version} has an unexpected native licensing README.`);
  }

  const binaries = nativePayloadBinaries(payload.directory);
  if (binaries.length === 0) {
    throw new Error(`${payload.name}@${payload.version} contains no native binaries.`);
  }

  return {
    packages: [
      {
        name: payload.name,
        version: payload.version,
        packagePath: payload.lockPath,
        lockIntegrity: lock.packages?.[payload.lockPath]?.integrity ?? null,
        versionsSha256: sha256FileSync(versionsFile),
        binaries,
      },
    ],
    versions,
    notices: [
      "# Native Third-Party Notices",
      "",
      "The following upstream notices describe libraries embedded in the Sharp/libvips",
      `native payload \`${payload.name}@${payload.version}\`. Full source archives and`,
      "license files accompany this application under `sources/`; canonical copyleft license",
      "texts are under `licenses/`.",
      "",
      notices,
      "",
    ].join("\n"),
  };
}

async function prepareRemoteMaterials({
  outputDir,
  rootDir,
  packages,
  policy,
  fetchImpl,
}) {
  const specs = buildStaticRemoteMaterialSpecs(policy);

  const onnxVersions = [
    ...new Set(
      packages
        .filter(({ name }) => name.startsWith("onnxruntime-"))
        .map(({ version }) => version),
    ),
  ].sort();
  for (const version of onnxVersions) {
    const ref = onnxRefForVersion(version, policy);
    const safeVersion = version.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    specs.push(
      {
        id: `onnxruntime-${version}-license`,
        fileName: `onnxruntime-${safeVersion}-LICENSE.txt`,
        outputPath: `onnxruntime/onnxruntime-${safeVersion}-LICENSE.txt`,
        url: `https://raw.githubusercontent.com/microsoft/onnxruntime/${ref}/LICENSE`,
        marker: "MIT License",
      },
      {
        id: `onnxruntime-${version}-notices`,
        fileName: `onnxruntime-${safeVersion}-ThirdPartyNotices.txt`,
        outputPath: `onnxruntime/onnxruntime-${safeVersion}-ThirdPartyNotices.txt`,
        url:
          `https://raw.githubusercontent.com/microsoft/onnxruntime/${ref}/` +
          "ThirdPartyNotices.txt",
        marker: "THIRD PARTY SOFTWARE NOTICES AND INFORMATION",
      },
    );
  }

  return mapLimit(specs, 4, async (spec) => {
    const target = path.join(outputDir, ...spec.outputPath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const cache = path.join(rootDir, ".compliance-cache", "remote", spec.fileName);
    await obtainFile(
      {
        ...spec,
        expectedSha256: reviewedMaterialHash(
          spec.id,
          policy.remoteMaterials,
          "Remote material",
        ),
      },
      cache,
      target,
      fetchImpl,
    );
    const content = await readFile(target, "utf8");
    if (!content.includes(spec.marker)) {
      throw new Error(`${spec.id} does not contain expected marker "${spec.marker}".`);
    }
    return {
      id: spec.id,
      url: spec.url,
      file: spec.outputPath,
      sha256: await sha256File(target),
    };
  });
}

async function prepareSources({
  outputDir,
  rootDir,
  policy,
  lock,
  nativeVersions,
  fetchImpl,
}) {
  const specs = buildComplianceSourceSpecs(
    nativeVersions,
    lock,
    policy,
    process.platform,
  );
  const sources = await mapLimit(specs, 4, async (spec) => {
    const relative = `sources/${spec.fileName}`;
    const target = path.join(outputDir, "sources", spec.fileName);
    await mkdir(path.dirname(target), { recursive: true });
    const cache = path.join(rootDir, ".compliance-cache", "sources", spec.fileName);
    const reviewedSpec = {
      ...spec,
      expectedSha256: reviewedMaterialHash(
        spec.id,
        policy.sourceMaterials,
        "Source material",
      ),
    };
    if (spec.gitRepository) {
      await obtainGitArchive(reviewedSpec, cache, rootDir);
      await copyFile(cache, target);
    } else {
      await obtainFile(reviewedSpec, cache, target, fetchImpl);
    }
    return {
      id: spec.id,
      version: spec.version,
      reason: spec.reason,
      url: spec.url,
      retrieval: spec.gitRepository ? "git-archive" : "download",
      file: relative,
      sha256: await sha256File(target),
      bytes: statSync(target).size,
    };
  });
  return { schemaVersion: 1, mode: "full", sources };
}

async function prepareElectronNotices({ outputDir, rootDir, policy, fetchImpl }) {
  const distributionKey = `${process.platform}-${process.arch}`;
  const expectedSha256 = reviewedMaterialHash(
    distributionKey,
    policy.electron.distributions,
    "Electron distribution",
  );
  const fileName =
    `electron-v${policy.electron.version}-${process.platform}-${process.arch}.zip`;
  const url =
    `https://github.com/electron/electron/releases/download/v${policy.electron.version}/` +
    fileName;
  const cache = path.join(rootDir, ".compliance-cache", "electron", fileName);
  await obtainCachedFile(
    {
      id: `electron-distribution-${distributionKey}`,
      fileName,
      url,
      expectedSha256,
    },
    cache,
    fetchImpl,
  );

  const archive = new AdmZip(cache);
  const reviewedNotices = policy.electron.notices?.[distributionKey];
  if (!reviewedNotices) {
    throw new Error(
      `Electron notices for ${distributionKey} have not been reviewed. Chromium's notice file ` +
        "differs per platform, so add the entry to third_party/compliance-policy.json.",
    );
  }
  const noticeDirectory = path.join(outputDir, "electron");
  await mkdir(noticeDirectory, { recursive: true });
  const notices = [];
  for (const [sourceName, targetName] of [
    ["LICENSE", "LICENSE.electron.txt"],
    ["LICENSES.chromium.html", "LICENSES.chromium.html"],
  ]) {
    const entry = archive.getEntry(sourceName);
    if (!entry || entry.isDirectory) {
      throw new Error(`Electron distribution is missing ${sourceName}.`);
    }
    const content = entry.getData();
    if (content.length < 100) {
      throw new Error(`Electron distribution notice ${sourceName} is unexpectedly short.`);
    }
    const target = path.join(noticeDirectory, targetName);
    await writeFile(target, content);
    const sha256 = await sha256File(target);
    const reviewed = reviewedMaterialHash(
      targetName,
      reviewedNotices,
      `Electron ${distributionKey} notice`,
    );
    if (sha256 !== reviewed) {
      throw new Error(
        `Electron distribution notice ${targetName} has SHA-256 ${sha256}, ` +
          `expected ${reviewed} for ${distributionKey}.`,
      );
    }
    notices.push({
      id: `electron-${targetName}`,
      file: `electron/${targetName}`,
      sha256,
    });
  }
  await writeJson(path.join(outputDir, "ELECTRON-NOTICES.json"), {
    schemaVersion: 1,
    version: policy.electron.version,
    platform: process.platform,
    architecture: process.arch,
    archive: { fileName, url, sha256: expectedSha256 },
    notices,
  });
}

async function obtainFile(spec, cache, target, fetchImpl) {
  await obtainCachedFile(spec, cache, fetchImpl);
  await copyFile(cache, target);
  if (statSync(target).size < 100) {
    throw new Error(`Downloaded compliance material ${spec.id} is unexpectedly short.`);
  }
}

async function obtainGitArchive(spec, cache, rootDir) {
  await mkdir(path.dirname(cache), { recursive: true });
  const cacheIsValid =
    existsSync(cache) &&
    statSync(cache).size >= 100 &&
    (await hasExpectedFileHeader(spec.fileName, cache)) &&
    (await sha256File(cache)) === spec.expectedSha256;
  if (cacheIsValid) return;

  await rm(cache, { force: true });
  const repository = path.join(
    tmpdir(),
    "skill-recorder-compliance-git",
    `${createHash("sha256").update(spec.id).digest("hex").slice(0, 16)}-${process.pid}`,
  );
  const temporary = `${cache}.partial`;
  await rm(repository, { recursive: true, force: true });
  await rm(temporary, { force: true });
  await mkdir(repository, { recursive: true });

  try {
    await runGit(["init", "--quiet"], repository);
    await runGit(
      [
        "fetch",
        "--depth=1",
        "--no-tags",
        "--quiet",
        spec.gitRepository,
        spec.gitRevision,
      ],
      repository,
    );
    const resolvedRevision = await runGit(["rev-parse", "FETCH_HEAD"], repository);
    if (resolvedRevision !== spec.gitRevision) {
      throw new Error(
        `Fetched ${spec.id} revision ${resolvedRevision}; expected ${spec.gitRevision}.`,
      );
    }

    await runGit(
      [
        ...deterministicGitConfigArgs,
        "archive",
        "--format=tar",
        `--prefix=${spec.archivePrefix}`,
        `--output=${temporary}`,
        "FETCH_HEAD",
      ],
      repository,
    );
    if (!(await hasExpectedFileHeader(spec.fileName, temporary))) {
      await rm(temporary, { force: true });
      throw new Error(`Generated source material ${spec.id} is not a valid tar archive.`);
    }
    const actualHash = await sha256File(temporary);
    if (actualHash !== spec.expectedSha256) {
      await rm(temporary, { force: true });
      throw new Error(
        `Generated source material ${spec.id} has SHA-256 ${actualHash}; ` +
          `expected reviewed hash ${spec.expectedSha256}.`,
      );
    }
    await rename(temporary, cache);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function runGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Git command failed while preparing compliance sources: ${detail}`, {
      cause: error,
    });
  }
}

async function obtainCachedFile(spec, cache, fetchImpl) {
  await mkdir(path.dirname(cache), { recursive: true });
  const cacheIsValid =
    existsSync(cache) &&
    statSync(cache).size >= 100 &&
    (await hasExpectedFileHeader(spec.fileName, cache)) &&
    (await sha256File(cache)) === spec.expectedSha256;
  if (!cacheIsValid) {
    await rm(cache, { force: true });
    await downloadWithRetry(spec.url, cache, fetchImpl);
  }
  if (!(await hasExpectedFileHeader(spec.fileName, cache))) {
    await rm(cache, { force: true });
    throw new Error(`Downloaded compliance material ${spec.id} has invalid file content.`);
  }
  const actualHash = await sha256File(cache);
  if (actualHash !== spec.expectedSha256) {
    await rm(cache, { force: true });
    throw new Error(
      `Downloaded compliance material ${spec.id} has SHA-256 ${actualHash}; ` +
        `expected reviewed hash ${spec.expectedSha256}.`,
    );
  }
}

async function downloadWithRetry(url, target, fetchImpl) {
  const temporary = `${target}.partial`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await rm(temporary, { force: true });
    try {
      const response = await fetchImpl(url, {
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
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw new Error(`Failed to download ${url} after three attempts.`, { cause: lastError });
}

export function renderRelinking(native, sourceManifest, policy, platform = process.platform) {
  const { versions } = native;
  const nativePackageList = native.packages.map(({ name }) => name).join(", ");
  const sourceFile = (id) => {
    const source = sourceManifest.sources.find((entry) => entry.id === id);
    if (!source && sourceManifest.mode === "full") {
      throw new Error(`Relinking guide requires source material ${id}.`);
    }
    return source?.file ?? `sources/[${id} omitted from licenses-only bundle]`;
  };
  const hasWindowsBuildSource = sourceManifest.sources.some(
    ({ id }) => id === "libvips-windows-build",
  );  const nativeLocation =
    platform === "darwin"
      ? "Contents/Resources/app.asar.unpacked/node_modules/"
      : "resources/app.asar.unpacked/node_modules/";
  const ffmpegLocation =
    platform === "darwin"
      ? "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib"
      : platform === "win32"
        ? "ffmpeg.dll beside the Skill Recorder executable"
        : "libffmpeg.so beside the Skill Recorder executable";
  const sharpBuildSource = sourceFile("sharp-libvips-build");
  const electronSource = sourceFile("electron");
  const ffmpegSource = sourceFile("electron-ffmpeg");
  const ffmpegPatch = sourceFile("electron-ffmpeg-patch-link-with-loader-path");
  const windowsBuildSource =
    platform === "win32" ? sourceFile("libvips-windows-build") : undefined;
  const replaceableFiles = native.packages.flatMap(({ name, binaries = [] }) =>
    binaries.map(({ file, sha256 }) => `- \`${nativeLocation}${name}/${file}\` (SHA-256 ${sha256})`),
  );
  return [
    "# Replacing and relinking native libraries",
    "",
    "Skill Recorder's own source is available under the MIT License at",
    "https://github.com/microsoft/skill-recorder. The native libraries listed in",
    "`NATIVE-COMPONENTS.json` remain under their own licenses.",
    "",
    "The packaged application keeps Sharp, libvips, and related native modules outside",
    `the ASAR archive under \`${nativeLocation}\`. Installed native packages:`,
    `\`${nativePackageList}\`. Electron's FFmpeg library is at \`${ffmpegLocation}\`.`,
    "",
    ...(replaceableFiles.length > 0
      ? [
          "The following files carry the LGPL-covered libvips runtime and may be replaced:",
          "",
          ...replaceableFiles,
          "",
        ]
      : []),
    "You may replace these files with ABI-compatible modified builds. The application",
    "loads them from the plain filesystem locations above; it does not verify their",
    "signatures or hashes at run time and takes no technical measure to prevent a",
    "modified replacement from running. You may also reverse engineer Skill Recorder to",
    "the extent necessary to debug modifications you make to those libraries.",
    "",
    "Exact upstream sources, packaging scripts, and build patches are included under",
    "`sources/`. `SOURCE-MANIFEST.json` records their original URLs and SHA-256 hashes.",
    "",
    "To rebuild and replace the libvips payload:",
    "",
    hasWindowsBuildSource
      ? `1. Unpack \`${sharpBuildSource}\` and \`${windowsBuildSource}\`. The latter contains the`
      : `1. Unpack \`${sharpBuildSource}\`. It contains the`,
    hasWindowsBuildSource
      ? "   MXE cross-build definitions and every patch applied to the Windows payload."
      : "   POSIX build scripts; externally fetched patches are included beside it in `sources/`.",
    "2. Unpack the matching upstream archives from `sources/` into the build tree, keeping",
    "   the versions recorded below and in `NATIVE-COMPONENTS.json`.",
    "3. Run the packaging build for this platform and architecture as documented by the",
    "   unpacked scripts.",
    `4. Copy the rebuilt libraries over the files listed above under \`${nativeLocation}\`,`,
    "   keeping the same file names, then start Skill Recorder normally.",
    "",
    `For Electron FFmpeg, start from \`${ffmpegSource}\`, apply \`${ffmpegPatch}\`,`,
    `and use the Electron build integration in \`${electronSource}\`. Replace the`,
    `resulting ABI-compatible library at \`${ffmpegLocation}\`.`,
    "",
    "Important pinned versions:",
    "",
    `- Electron: ${policy.electron.version}`,
    `- Electron FFmpeg revision: ${policy.electron.ffmpegRevision}`,
    `- Sharp: ${policy.sharp}`,
    `- Sharp/libvips packaging: ${policy.sharpLibvips.version}`,
    `- libvips: ${versions.vips}`,
    `- GLib: ${versions.glib}`,
    `- Cairo: ${versions.cairo}`,
    "",
    sourceManifest.mode === "full"
      ? "This distribution includes the corresponding-source materials."
      : "This licenses-only bundle is not suitable for redistribution.",
    "",
  ].join("\n");
}

function renderComplianceReadme(includeSources) {
  return [
    "# License and source materials",
    "",
    "Keep this entire directory with every distributed copy of Skill Recorder.",
    "",
    "- `THIRD-PARTY-LICENSES.txt` contains per-package license and attribution text.",
    "- `NATIVE-THIRD-PARTY-NOTICES.md` identifies libraries embedded in native payloads.",
    "- `onnxruntime/` contains exact ONNX Runtime third-party notices.",
    "- `tesseract-core/` contains notices for libraries embedded in the OCR WebAssembly.",
    includeSources
      ? "- `electron/` contains the exact Electron and Chromium notices from this build."
      : "- Electron notices are added when a redistributable build is prepared.",
    "- `licenses/` contains complete GPL, LGPL, MPL, and Artistic-2.0 license texts.",
    "- `RELINKING.md` explains replacement and relinking of native libraries.",
    "- `SOURCE-MANIFEST.json` maps corresponding-source archives to their origins.",
    "",
    includeSources
      ? "The `sources/` directory accompanies this redistributable build."
      : "This development bundle omits sources and must not be redistributed.",
    "",
  ].join("\n");
}

function renderMitFallback(pkg) {
  const owner = packageAuthor(pkg.metadata);
  return [
    `Available attribution from package metadata: ${owner}`,
    "",
    "MIT License",
    "",
    `Copyright (c) ${owner}`,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
  ].join("\n");
}

function renderIscFallback(pkg) {
  const owner = packageAuthor(pkg.metadata);
  return [
    `Available attribution from package metadata: ${owner}`,
    "",
    `Copyright (c) ${owner}`,
    "",
    "Permission to use, copy, modify, and/or distribute this software for any",
    "purpose with or without fee is hereby granted, provided that the above",
    "copyright notice and this permission notice appear in all copies.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH',
    "REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY",
    "AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,",
    "INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM",
    "LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR",
    "OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR",
    "PERFORMANCE OF THIS SOFTWARE.",
  ].join("\n");
}

function packageAuthor(metadata) {
  if (typeof metadata.author === "string" && metadata.author.trim()) {
    return metadata.author.trim();
  }
  if (metadata.author?.name) return metadata.author.name;
  if (metadata.maintainers?.length) {
    return metadata.maintainers
      .map((maintainer) => maintainer.name ?? maintainer.email)
      .filter(Boolean)
      .join(", ");
  }
  throw new Error(`${metadata.name}@${metadata.version} has no attribution metadata.`);
}

function normalizeLicense(license) {
  if (typeof license === "string") return license;
  if (license?.type) return license.type;
  if (Array.isArray(license)) return license.map(normalizeLicense).join(" OR ");
  return "(missing)";
}

function withoutPatch(version) {
  return version.split(".").slice(0, -1).join(".");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256FileSync(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function removeStalePartialFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeStalePartialFiles(target);
    } else if (entry.isFile() && entry.name.endsWith(".partial")) {
      await rm(target, { force: true });
    }
  }
}
