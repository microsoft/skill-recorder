# Skill Recorder

**Record yourself doing a task once — turn it into a skill your AI agent can repeat.**

Skill Recorder captures a real work session on your screen — the clicks, the app and
window switches, the pages you visit, and (if you want) your spoken narration — then uses
the **GitHub Copilot CLI** to reconstruct *what you actually did* as a clear **intent plus
an ordered list of steps**. From there, one step turns that single run into something an
agent can reuse:

- a **Skill** — a `SKILL.md` procedure an agent runs on demand, or
- an **Automation** — the same procedure on a schedule or trigger.

Both prefer the agent's **native tools** (like the `gh` CLI or `web_fetch`) over replaying
UI clicks, and generalize from your one example — so recording yourself submitting *one*
form can teach the agent to submit *all* of them.

<p align="center">
  <img src="docs/images/recorder.png" alt="Skill Recorder capture window: a record button, timer, optional narration toggle, and readiness checks" width="420">
  &nbsp;&nbsp;
  <img src="docs/images/library.png" alt="Skill Recorder library: recorded sessions on the left, the reconstructed intent and ordered steps on the right" width="520">
</p>

## How it works

1. 🔴 **Record** — Hit record (or `⌘⇧R` / `Ctrl+Shift+R` from anywhere) and just do your
   task. Skill Recorder captures your screen and activity locally, in the background.
2. 🎛️ **Control** — While recording, a small always-on-top bar shows capture and
   microphone state. Mute, unmute, or switch mics on the fly, then finish — or discard
   (with a confirmation) if the take didn't go to plan.
3. 🧠 **Analyze** — Click Analyze and GitHub Copilot reconstructs one overall intent and
   an ordered list of steps. Review and edit until it reads right.
4. ✨ **Create** — From an approved analysis, generate a reusable **Skill** and/or a
   scheduled **Automation**.

## Get started

**macOS / Ubuntu**

```sh
commit="<40-character-release-commit>"; curl -fsSL "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.sh" | SKILL_RECORDER_COMMIT="$commit" bash
```

The release commit pins both the downloaded script and the source it builds. To keep the
application running after the terminal closes, add `SKILL_RECORDER_DETACHED=1` after the
pipe:

```sh
commit="<40-character-release-commit>"; curl -fsSL "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.sh" | SKILL_RECORDER_COMMIT="$commit" SKILL_RECORDER_DETACHED=1 bash
```

On macOS the installer also adds a **Skill Recorder (Source)** app to `~/Applications`, so
you can relaunch it later from Spotlight, Launchpad, or the Dock without re-running the
command. On Ubuntu it adds a matching application entry.

**Windows**

Use the commit-pinned source installer documented in [`INSTALL.md`](INSTALL.md). The
published command must identify a full 40-character release commit. It downloads a
verified portable Node.js 24 runtime, builds that exact source revision locally, preserves
the required license materials, and creates **Skill Recorder (Source)** shortcuts on your
desktop and in the Start Menu — all without installing Node system-wide. When it finishes
it prints where both shortcuts were saved. Re-running the same command with the same
commit reuses the installed revision instead of downloading and rebuilding it again.

Both paths install dependencies from their publishers and build Skill Recorder locally.
The platform-specific Copilot CLI is installed with the application dependencies; a global
CLI installation is not required. The first time you choose *Analyze* without stored
Copilot credentials, Skill Recorder says so and offers **Sign in to Copilot**, which opens
a terminal running the bundled CLI's `login` command (the same command is shown so you can
run it yourself). On first launch, macOS asks for **Screen Recording**
permission — grant it and you're ready to record.

> ⚠️ **Keep secrets out of your recordings.** Don't record, type, paste, or narrate
> passwords, tokens, API keys, or other confidential info — choosing *Analyze* sends
> recording data to GitHub's cloud. Skill Recorder reminds you before every recording.
> Details in [What gets captured](#what-gets-captured).

<details>
<summary>Source installer options &amp; updating</summary>

Set any of these environment variables when you run the command:

| Variable | Default | What it does |
| --- | --- | --- |
| `SKILL_RECORDER_COMMIT` | *(required)* | exact 40-character source commit |
| `SKILL_RECORDER_INSTALL_ROOT` | per-user platform path | source and portable runtime location |
| `SKILL_RECORDER_NO_LAUNCH` | *(unset)* | set to `1` to install without launching |
| `SKILL_RECORDER_NO_DESKTOP_SHORTCUT` | *(unset)* | Windows: set to `1` to skip the desktop shortcut |
| `SKILL_RECORDER_DETACHED` | *(unset)* | macOS/Ubuntu background launch with rolling logs |
| `SKILL_RECORDER_LOG_KEEP` | `5` | macOS/Ubuntu detached log retention |

Re-run the platform command with a new release commit to update. Inspect-first,
platform-specific relaunch, and uninstall instructions are in [`INSTALL.md`](INSTALL.md).
</details>

---

*The rest of this README is for people who want the details — or want to hack on the code.*

## Requirements

- **macOS** (primary target). Windows 11 x64 and ARM64 are also supported — see
  [`WINDOWS-VALIDATION.md`](WINDOWS-VALIDATION.md).
- **Node.js 24** for manual source development. Installers provide a private runtime when
  needed.
- A GitHub account with **Copilot access** and authentication. Dependency installation
  includes the platform-specific Copilot CLI used by the SDK.
- No system media tools required — Chromium handles screen snapshots and narration audio
  decoding. A system `ffmpeg` is only used to open recordings made by an older Skill
  Recorder version that has no snapshot manifest.

On first launch macOS prompts for **Screen Recording** (required). Turning on **Narrate**
requests **Microphone** permission immediately so you can pick a named input before
recording; that permission-check stream is released without saving any audio.

## What gets captured

Recording, storage, frame extraction, and optional narration transcription all happen
**on your computer** — nothing leaves while you record. Only when you choose **Analyze**
does Skill Recorder send the event timeline (window/document titles, URLs, and clipboard
previews), extracted screen images, narration text, and anything else you provide to
GitHub's cloud service for Copilot to process.

> ⚠️ **Please don't capture secrets.** Passwords, access tokens, API keys, credentials, and
> other confidential information should never be recorded, typed, pasted, shown, copied,
> or narrated during a session.

The in-app "Records your screen and activity" panel spells out exactly what's collected:

- **Window tracking** — active-app / window switches (Koffi/Win32 on Windows,
  `get-windows` elsewhere).
- **Browser URLs** — the page you're on (macOS, via AppleScript).
- **Screen video** — recorded by Chromium; low-rate snapshots are captured alongside it
  and retained only when the screen changes or a heartbeat is due.
- **Clipboard** — short previews of copied text that tie steps together.
- **Narration** *(optional)* — turn on **Narrate** before capture or toggle the microphone
  from the floating recording bar. Narrate shows the active input and remembers a selected
  microphone, with an explicit **System default** fallback. During capture, the bar can
  switch inputs without interrupting screen recording; each microphone-on interval is
  timestamped on the video timeline, saved locally, and can be transcribed **on-device** in
  any of Whisper's 99 supported languages (via transformers.js), preserving the selected
  language. The first transcription uses an explicit, one-time ~252 MB model download. The
  multilingual q8 checkpoint is only about 0.6 MB larger than the previous English-only
  model and uses the same `small` architecture, so runtime memory and transcription speed
  are expected to remain effectively unchanged.

## Install or develop from source

See [`INSTALL.md`](INSTALL.md) for the commit-pinned Windows source installer,
the inspect-first alternative, manual developer setup, updates, uninstallation,
and the licensing boundary between local source builds and redistributable
packages.

For development after checking out an exact revision:

```bash
npm ci
npm run compliance:licenses
npm run dev
```

`npm run dev` starts Vite and launches the Electron app with hot-reload. The app also
lives in the menu-bar tray; `⌘⇧R` (macOS) / `Ctrl+Shift+R` (Windows) toggles recording
from anywhere. On Windows, press `F12` while the recorder or Sessions window is focused to
toggle DevTools during development.

Other useful scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build (dist/ + dist-electron/)
npm run dist        # build a compliant non-Windows distributable in release/
npm run dist:win:x64    # requires native Windows x64
npm run dist:win:arm64  # requires native Windows ARM64
npm run dist:portable:mac # compliant unsigned macOS ZIP
npm run dist:portable:win # compliant unsigned Windows x64 portable executable
npm run compliance:licenses # validate the installed dependency license inventory
npm start           # run the last build with `electron .`
```

Distributable builds download the exact corresponding-source archives and
license materials required by bundled native libraries. They are packaged
outside the ASAR under `resources/compliance/`; a release fails if any required
notice, source archive, or relinking instruction is missing or differs from its
reviewed SHA-256. Locally generated source builds must not be redistributed.

Maintainers must follow [`RELEASING.md`](RELEASING.md) when changing versions,
dependencies, assets, release notes, tags, source installers, or binary
downloads.

## Evals

The variable part of the system — the Copilot **describer** and **builders** — has a
fixture-based eval suite. See [`evals/README.md`](evals/README.md).

```bash
npm run eval            # score the describer against synthetic recordings
npm run eval:builder    # score the skill/automation generalization
```

## License

[MIT](LICENSE)

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
