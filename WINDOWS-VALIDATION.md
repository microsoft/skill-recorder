# Windows validation

Skill Recorder supports native Windows 11 builds for both x64 and ARM64. The
architecture gate lives in [`.github/workflows/windows.yml`](.github/workflows/windows.yml)
and runs on GitHub's `windows-latest` and native `windows-11-arm` images.

## Architecture-sensitive components

| Component | Windows x64 | Windows ARM64 | Notes |
|---|---:|---:|---|
| Electron 43 | Yes | Yes | Official Electron archives |
| Koffi / foreground-window FFI | Yes | Yes | Prebuilt N-API packages; no compiler |
| Sharp / libvips | Yes | Yes | `@img/sharp-win32-*` packages |
| ONNX Runtime | Yes | Yes | Both payloads ship in `onnxruntime-node` |
| GitHub Copilot CLI | Yes | Yes | `@github/copilot-win32-*` packages |
| TypeScript, Rolldown, Lightning CSS | Yes | Yes | Native development packages exist for both |
| Standalone FFmpeg / `ffmpeg-static` | No | No | Chromium replaced all current media uses |
| Electron `ffmpeg.dll` codec library | Yes | Yes | LGPL-2.1+; standard Electron component and notices |

`get-windows` remains an optional dependency for macOS/Linux. Windows uses Koffi
to call `user32`, `dwmapi`, and `kernel32` directly, so a missing Windows
`get-windows` prebuild cannot break installation or runtime capture.

## Why native ARM64 installation now works

The previous install blocker was `ffmpeg-static`, whose postinstall script had no
Windows ARM64 binary. It has been removed from `package.json`, the lockfile,
Vite externals, electron-builder unpack rules, and packaged output.

Screen recording still uses Chromium's VP8/VP9 `MediaRecorder`. In parallel, the
capture renderer reads the desktop track, deduplicates 1 fps snapshots, and writes
a heartbeat at least every five seconds. Post-processing selects, crops, and
deduplicates those JPEGs without decoding the WebM.

Narration no longer shells out to FFmpeg either. A hidden Chromium renderer
decodes Opus/WebM with `AudioContext`, downmixes/resamples to 16 kHz mono, and the
main process performs silence detection before Whisper transcription.

## Automated gate

For each Windows architecture, CI:

1. Installs native Node 24 and runs `npm ci`.
2. Loads Sharp, ONNX Runtime, and Koffi.
3. Runs unit tests and the production build.
4. Builds the architecture-specific NSIS installer.
5. Verifies the packaged PE machine type and the Sharp, ONNX, Koffi, and Copilot
   payload architecture.
6. Inspects loose and `app.asar` paths, fails if `ffmpeg-static` or a standalone
   FFmpeg executable appears, and verifies Electron's codec DLL and license notices.

Release publication is additionally gated on attaching the pinned LGPL source
and relinking materials listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Local equivalents:

```powershell
npm ci
npm test
npm run build
npm run dist:win:arm64  # on native Windows ARM64
node scripts/verify-windows-package.mjs arm64
```

Use `dist:win:x64` and `x64` for the x64 package. Building each installer on its
native runner ensures npm selects the correct optional native packages. The package
scripts reject cross-architecture builds instead of producing an installer containing
host-architecture Koffi, Sharp, or Copilot binaries.

## Manual Windows ARM64 smoke test

Automated packaging cannot validate desktop permissions or real foreground apps.
Before a release, run this checklist on a physical Windows 11 ARM64 machine:

1. Confirm `node -p "process.arch"` and the running Electron process both report
   `arm64`.
2. Start a two-minute recording, leave the screen static for at least 15 seconds,
   then switch among a Win32 app, Settings, a browser, and an elevated app.
3. Confirm `app.activate` records the owning process (not
   `ApplicationFrameHost.exe` for Settings) and does not crash on the elevated app.
4. Confirm `video.webm`, `video-frames.json`, periodic files under
   `video-frames/`, and retained JPEGs under `frames/`.
5. Request cropped frames from the Sessions analysis and verify exact crop
   dimensions and readable text.
6. Record narration, transcribe it, and confirm timestamped segments without a
   system FFmpeg installation.
7. Open a pre-change recording. With system FFmpeg installed, legacy frame
   extraction should work; without it, the event-only analysis must still work
   and log one actionable compatibility warning.

## AI connection and credential smoke checks

Run these checks on Windows 11 x64 and ARM64, and repeat the storage/restart
checks on macOS and Ubuntu before claiming native support is verified:

1. With no AI preference saved, choose Analyze and confirm both BYOM and GitHub
   are offered. Recording itself must not require either.
2. Select GitHub and confirm the existing Microsoft-hinted SSO and standard
   personal-account paths are unchanged.
3. Configure a vision/tool-capable BYOM model without signing in to GitHub.
   Check analysis and both builders. The synthetic connection test is billable.
4. Restart and confirm a saved key is recovered using DPAPI on Windows, Keychain
   on macOS, or a supported secure desktop keyring on Ubuntu.
5. Test an unavailable/locked key store. Before key entry, the form must show the
   memory-only disclaimer, without an extra dialog or blocking BYOM. After
   restart the key is requested again, while endpoint/model settings remain.
6. Forget the key and restart; it must not return. Check connection switching is
   prevented during active work and resets idle model conversations.
7. Check app/runtime logs, generated files, and debug exports for a test-only key
   marker. No credential may be written unprotected or exported.

Unit tests exercise secure and insecure backend behavior with injected stores;
they do not substitute for these native OS checks or live provider validation.

## Known limitations

- Browser URL capture still uses the existing Windows PowerShell UI Automation
  sidecar. Core app/window tracking does not depend on PowerShell.
- Snapshot information is capped by the intentional 1 fps desktop capture rate.
  Asking for a higher sampling density cannot create additional visual detail.
- A standalone system FFmpeg is optional and legacy-only; it is never downloaded,
  bundled, or required for new recordings. Electron's standard LGPL codec DLL
  remains part of the Chromium runtime.
