# Third-Party Notices

Skill Recorder is licensed under the MIT License (see [`LICENSE`](./LICENSE)).

Packaged/distributed builds include third-party components that are covered by
their own license terms. This file summarizes the notable ones. Every supported
release command generates a complete, platform-specific compliance bundle under
`resources/compliance/` containing full package license texts, native notices,
copyleft license texts, corresponding source, and relinking instructions.
Electron's exact notices are retained under `resources/compliance/electron/`;
platforms that preserve Electron's root notice files carry those copies too.

The dependency tree is otherwise permissive (MIT, ISC, Apache-2.0, BSD,
Artistic-2.0, BlueOak-1.0.0) and compatible with distributing this application under MIT.
Those components remain under their own terms; the generated
`THIRD-PARTY-LICENSES.txt` preserves their license and attribution text.

## Optional downloaded model

### OpenAI Whisper small — `Xenova/whisper-small`
- The multilingual model is downloaded from
  [`Xenova/whisper-small`](https://huggingface.co/Xenova/whisper-small) only
  after explicit user approval; its weights are not bundled with Skill Recorder.
- The Transformers.js-compatible ONNX conversion is published by Xenova
  (Joshua Lochner) from OpenAI's
  [`openai/whisper-small`](https://huggingface.co/openai/whisper-small)
  checkpoint.
- The Hugging Face model metadata declares **Apache-2.0**. OpenAI's
  [Whisper repository](https://github.com/openai/whisper) also states that its
  code and model weights are released under the **MIT License**. The downloaded
  model remains subject to its publisher's applicable terms and does not change
  Skill Recorder's MIT license.

### Tesseract English language data — `tessdata_fast/eng.traineddata`
- Advanced protection downloads the English OCR data directly from
  [`tesseract-ocr/tessdata_fast`](https://github.com/tesseract-ocr/tessdata_fast)
  only when OCR is enabled; it is not bundled with Skill Recorder.
- The file is pinned to commit
  [`65727574dfcd264acbb0c3e07860e4e9e9b22185`](https://github.com/tesseract-ocr/tessdata_fast/tree/65727574dfcd264acbb0c3e07860e4e9e9b22185)
  and SHA-256
  `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`.
- The language data is Apache-2.0. Its exact license is retained under
  `resources/compliance/tesseract-core/`, even though the model is fetched
  from its publisher rather than redistributed in the application.

## Bundled runtime components

### GitHub Copilot CLI — `@github/copilot` (+ platform binary `@github/copilot-<platform>-<arch>`)
- License: **GitHub Copilot CLI License** (proprietary) — see
  `node_modules/@github/copilot/LICENSE.md`.
- Pulled in by `@github/copilot-sdk` (MIT) and spawned as a separate process.
- Redistribution is permitted **only** as an unmodified copy bundled as part of
  this application, with the license and all copyright/attribution notices
  retained. The license explicitly states it does not restrict this
  application's own license, including distribution under an open-source (MIT)
  license.

### Electron / Chromium media codecs
- License: Electron is **MIT**. Its Chromium runtime includes `ffmpeg.dll`
  (`libffmpeg.dylib` / `libffmpeg.so` on other platforms), a dynamically loaded
  codec library whose bundled notice identifies FFmpeg as **LGPL-2.1-or-later**.
  GPL portions require an explicit non-default FFmpeg build configuration.
- Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` are retained in
  every packaged application. Chromium's notice file differs per platform, so it
  is reviewed separately for each release target.
- The currently pinned source is Electron
  [`v43.1.1`](https://github.com/electron/electron/tree/v43.1.1), Chromium
  [`150.0.7871.114`](https://chromium.googlesource.com/chromium/src/+/150.0.7871.114),
  and Chromium FFmpeg revision
  [`ad41607c61898cf7150e0fb20fe4bbabd44922a3`](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/ad41607c61898cf7150e0fb20fe4bbabd44922a3).
  The Electron source archive and its applied FFmpeg patch queue accompany each
  release.
- Chromium records the WebM media, captures screen snapshots, and decodes
  narration audio. Skill Recorder does **not** distribute `ffmpeg-static` or a
  standalone FFmpeg executable.
- A user-installed standalone FFmpeg may be invoked only to read a recording
  created before snapshot manifests were introduced. That executable is not part
  of this app.

### Sharp / libvips — `sharp` and `@img/sharp-*`
- `sharp` is **Apache-2.0**. Its Windows native packages are
  **Apache-2.0 AND LGPL-3.0-or-later**; other platforms load the corresponding
  **LGPL-3.0-or-later** `@img/sharp-libvips-*` package.
- The currently pinned source is Sharp
  [`v0.35.3`](https://github.com/lovell/sharp/tree/v0.35.3), its reproducible
  packaging scripts
  [`sharp-libvips v1.3.2`](https://github.com/lovell/sharp-libvips/tree/v1.3.2),
  and libvips
  [`v8.18.3`](https://github.com/libvips/libvips/tree/v8.18.3). The unpacked
  native module remains replaceable in the packaged application.
- Sharp also publishes a WebAssembly build, `@img/sharp-wasm32`, which npm
  installs on every platform because its FreeBSD and WebContainers wrappers
  declare the platform constraints. Skill Recorder never loads it and excludes it
  and its WASM-only runtime dependency `@emnapi/runtime` from every packaged
  artifact, so neither is distributed.
- The native payload also contains libraries under MPL-2.0, MIT, BSD, ISC,
  fontconfig, FreeType, libpng, libtiff, zlib, and related permissive terms.
  The exact upstream table is distributed as
  `resources/compliance/NATIVE-THIRD-PARTY-NOTICES.md`.

### ONNX Runtime

`onnxruntime-node`, `onnxruntime-web`, and `onnxruntime-common` are MIT. Their npm
packages omit standalone license and third-party-notice files, so exact notices
from each pinned source revision are included under
`resources/compliance/onnxruntime/`.

### Tesseract OCR WebAssembly — `tesseract.js` and `tesseract.js-core`

- `tesseract.js@7.0.0` and `tesseract.js-core@7.0.0` are Apache-2.0.
  Apache-2.0 does not require corresponding source, but it does require
  retaining the license, copyright, and any applicable notices.
- The packaged WebAssembly is built from
  [`tesseract.js-core` commit `acffef2b66eb44a31df297e11d905f4b39001068`](https://github.com/naptha/tesseract.js-core/tree/acffef2b66eb44a31df297e11d905f4b39001068).
  Its build scripts statically link the pinned GIFLIB, Leptonica, IJG libjpeg,
  libpng, libtiff, libwebp, OpenLibm, Tesseract, and zlib revisions recorded
  in `SOURCE-MANIFEST.json`.
- Exact upstream terms are retained under
  `resources/compliance/tesseract-core/`; fixed source archives for the build
  scripts and all nine linked projects are retained under
  `resources/compliance/sources/`.
- As required by the IJG terms: **This software is based in part on the work
  of the Independent JPEG Group.**
- OpenLibm's source tree contains LGPL-covered test files, but its static
  library build does not compile or link those tests into the OCR WebAssembly.

### Release source materials

Redistributable builds include the complete GPL-3.0, LGPL-2.1, LGPL-3.0, and
MPL-2.0 texts. They also include source archives for Electron's FFmpeg revision,
Sharp, libvips, every library embedded in the Sharp native payload, the
applicable packaging repositories, and all externally applied build patches.
For reproducibility and notice preservation, the bundle also includes the
fixed Tesseract.js-core build source, all statically linked OCR sources, and
verbatim source packages for Artistic-2.0 dependencies.
`SOURCE-MANIFEST.json` records the origin, version, SHA-256, and purpose of every
file. Every remote payload is checked against a reviewed SHA-256 before use;
the FFmpeg archive is deterministically generated from its pinned Git commit.
`RELINKING.md` identifies platform-specific unpacked shared-library locations
and explains how to rebuild and replace them.

### Other native modules
- `get-windows` — MIT
- `koffi` / `@koromix/koffi-*` — MIT; used for Win32 foreground-window calls,
  including the native Windows ARM64 build.
- `sharp` — Apache-2.0; see the Sharp/libvips section for native payload terms

## Apache-2.0 components
Some dependencies (including `sharp`, `tesseract.js`, and
`tesseract.js-core`) are Apache-2.0, which requires retaining their
copyright, license, and any `NOTICE` file contents. The release process collects
these from the exact installed dependency tree into
`resources/compliance/THIRD-PARTY-LICENSES.txt` and fails if any package lacks
reviewed license material.

## Artistic-2.0 components

Secretlint's text-source handling introduces `binaryextensions`, `editions`,
`istextorbinary`, `textextensions`, and `version-range` under Artistic-2.0.
Redistributable builds retain their copyright notices, the complete
Artistic-2.0 text under `resources/compliance/licenses/`, and verbatim source
packages referenced by `SOURCE-MANIFEST.json`.

## Generating a complete license manifest
To validate installed package notices without downloading corresponding source:

```sh
npm run compliance:licenses
```

All `npm run dist*` commands run the full `npm run compliance:prepare` process
automatically. Electron Builder's `afterPack` hook refuses to create an
installer if the bundle is incomplete or if a build output directory was
recursively packaged.
