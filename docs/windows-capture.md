# Windows event capture

Skill Recorder is cross platform (macOS + Windows). The core (recorder controller,
event bus, session store, collector host, capture tiers, describer, skill builder)
is platform agnostic. This doc covers the parts that are OS specific: how each
event source behaves on Windows, how to set it up, and a live smoke test to run
before trusting a Windows build.

## What captures what on Windows

| Source | Mechanism on Windows | Parity vs macOS | Permission |
|--------|----------------------|-----------------|------------|
| App switches | Koffi calls to Win32 `user32` / `kernel32` | Full | None |
| Window titles | Koffi calls to Win32 `user32` | Full (better: no grant needed) | None |
| Browser URLs | UI Automation address bar read (`powershell.exe` host) | Functional, not byte exact | None |
| Clipboard | Electron clipboard | Full | None |
| Screen video + frames | `desktopCapturer` + Chromium snapshots + Sharp | Full | Screen capture |
| Voice narration (opt-in) | hidden-window `getUserMedia` + `MediaRecorder`; Chromium decode + offline Whisper | Full | Microphone |

Notes:

- **Browser URLs** read the *omnibox display value* through UI Automation
  (`electron/collectors/windows-url-provider.ts`), not the exact active tab URL
  the macOS AppleScript provider gets. That is enough for host level step
  segmentation, and unlike macOS it also reads **Firefox**. Values that look like
  a search term (whitespace, or no dot) are dropped rather than emitted as noise.
- **Window titles** need no OS permission on Windows (macOS needs Accessibility).

## Prerequisites

1. **Native window FFI.** Koffi ships prebuilt N-API packages for both
   `win32-x64` and `win32-arm64`; no compiler is needed.
2. **Windows PowerShell.** `powershell.exe` (Windows PowerShell 5.1, in-box on
   every Windows 10/11) is used to host the UI Automation URL reader. No install
   needed.
3. **Copilot CLI** on `PATH` for the describer (`copilot`).
4. No system media package is needed for new recordings.

## Doctor signals

Open the recorder HUD and read the doctor rows (or call `doctor()` over IPC).
On Windows, confirm:

- **window tracking** = `koffi` (not `provider missing`).
- **browser URLs** = `uia` when the capture level includes URLs.
## Live smoke test

Run a real recording on Windows and verify each source lands in the session's
`events.jsonl`. Set the capture level to **Full** first so every source is on.

1. **Start** capture from the HUD (or `Ctrl+Shift+R`).
2. **App switches / titles.** Alt-Tab between two apps (e.g. Edge and Notepad).
   Expect `app.activate` events with the right `owner.name`, and
   `app.title-change` as titles change.
3. **Browser URLs.** In Edge or Chrome, navigate to two different sites. Expect
   `browser.url` events with the address bar URL and `host`. Try Firefox too.
   Typing a partial URL or a search term should not emit a bogus event.
4. **Clipboard.** Copy some text. Expect a `clipboard.change` event with a
   preview and hash.
5. **Video.** Confirm `video.webm`, `video-frames.json`, snapshots under
   `video-frames/`, and retained images under `frames/`.
6. **Voice narration.** Turn on **Narrate**, open its settings, and confirm the
   language selector lists all 99 supported languages alphabetically and defaults
   to English. Grant microphone access and select a named input or **System default**.
   During capture, use the main microphone button to mute/unmute and its adjacent
   menu to switch inputs. Speak before and after a switch, then confirm `audio.json`
   contains separate version-2 segments with `narrationLanguage`; their
   session/video offsets should preserve the boundary. Disconnecting the active
   device must stop microphone capture with a visible error rather than silently
   recording from another input; reconnecting it should restore the saved preference
   when Chromium can identify it. If the model is not installed, starting analysis
   approves the one-time ~252 MB Whisper download. Confirm `narration.json` records
   the chosen language and contains the original-language words with `atMs` offsets.
   Exercise representative languages, including English and a non-Latin script.
   Later runs are offline. On Windows the mic grant is requested by the OS on first
   use.
7. **Recording controls.** Confirm the floating bar stays above the active app,
   its microphone menu and discard confirmation expand above the fixed bar, it can
   be dragged without making its buttons unclickable, and it does not appear in
   captured frames where Windows capture protection is supported. Canceling the
   discard confirmation must continue the same recording; confirming it must leave
   no saved session.
8. **Stop.** The recording should show up in the library as `recorded`, and
   analysis should produce a coherent intent + ordered steps.

If a source produces nothing, check the doctor row for it first, then the main
process log for the one-time warnings (e.g. "Browser URL capture is on but
unavailable on this platform", or a reduced-capture notice).

## Packaging

`package.json` configures electron-builder for macOS and Windows NSIS. Native
modules (`koffi`, `@koromix/*`, `sharp`, `@img/*`,
`@huggingface/transformers`, `onnxruntime-node`, and Copilot platform packages)
are listed under `asarUnpack` so
their binaries load from disk rather than from inside the asar archive. The
Whisper model itself is not bundled. It downloads to the app's user-data
`models` folder only after the user approves the one-time ~252 MB download from
the HUD or Sessions; recording and core session processing do not wait for it.
The multilingual q8 files total about 251.9 MB versus 251.2 MB for the previous
English-only checkpoint. Both use the same Whisper `small` architecture, so
runtime memory and transcription speed are expected to remain effectively
unchanged.

Build each Windows installer on its matching native machine or CI runner so npm
selects the correct optional packages:

```powershell
npm ci
npm run dist:win:x64
# or, on Windows ARM64:
npm run dist:win:arm64
```

The Windows workflow uses `windows-latest` and `windows-11-arm`, then verifies the
PE architecture and packaged native payloads.

## Known limitations

- Browser URLs are best effort display strings, not the exact tab URL.
- The recorded terminal captures only the PowerShell session opened from Skill
  Recorder's floating recording bar. It uses ConPTY and does not observe existing
  PowerShell, Windows Terminal, or cmd.exe windows. The design is tracked in issue #5.
- Semantic UI events (focus/invoke/value via UI Automation) are not implemented
  on either platform yet.
- `onnxruntime-node` ships prebuilt binaries for `win32-x64` and
  `win32-arm64`, so narration transcription needs no compiler.
- A standalone system FFmpeg is consulted only for frame extraction from recordings
  created before `video-frames.json` existed. It is never bundled or downloaded;
  Electron's standard LGPL `ffmpeg.dll` codec component remains in the runtime.
- The Windows paths are also validated by typecheck, a PowerShell parse check of
  the UIA script, and a `win32` describer eval
  (`evals/scenarios/windows-deploy.ts`).
