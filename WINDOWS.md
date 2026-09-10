# Running Skill Recorder on Windows

This guide covers the Windows-specific gotchas encountered while setting up
Skill Recorder from source. The macOS path in the main README is the primary
supported flow; the notes below fill the gaps for Windows.

## Prerequisites

- **Node.js 24.19.0 or newer** (the project pins `engines` to `>=24.19.0 <25`).
  Download from https://nodejs.org and verify with `node -v`.
- Git with submodule support.
- Windows 10/11. (Windows is a secondary platform; expect occasional rough edges.)

## Install

```bash
git clone --recurse-submodules https://github.com/microsoft/skill-recorder.git
cd skill-recorder
npm ci
```

### Important: install the reviewed Electron binary

`npm ci` installs the `electron` npm package but does **not** download the
actual Electron binary or generate the reviewed runtime metadata that
`npm run dev` requires. If you skip this step, `npm run dev` crashes instantly
("flashes and exits") with an `ENOENT` for
`node_modules/electron/.skill-recorder-reviewed.json`.

Run the reviewed-Electron installer after `npm ci`:

```bash
npm run electron:install-reviewed
```

This downloads the version pinned in `third_party/compliance-policy.json`,
verifies its SHA-256, extracts it to `node_modules/electron/dist/`, and writes
the reviewed metadata. After this, `npm run dev` works.

If your network cannot reach GitHub Releases directly, download the matching
`electron-v<version>-win32-x64.zip` from a mirror (for example
`https://registry.npmmirror.com/-/binary/electron/`), then point the installer
at the local archive to skip the download:

```bash
node scripts/install-reviewed-electron.mjs --archive <path-to-zip>
```

## Launch

Helper scripts live at the project root (optional — you can also just run
`npm run dev` directly):

- `start.bat` — launch dev mode (Vite HMR + Electron GUI). It checks for Node 24,
  sets `ELECTRON_MIRROR` for faster binary resolution, and keeps the window open
  on error so you can read the stack trace instead of a silent flash.
- `stop.bat` — stop only the Skill Recorder processes spawned from this project
  directory. It matches by command line, so it will **not** kill unrelated
  Electron apps such as VS Code or Discord.

> When recording, do not type or narrate passwords, tokens, or API keys —
> Analyze sends screen frames + narration to GitHub Copilot.

## Signing in to GitHub Copilot

Skill Recorder's **Analyze** step is powered by GitHub Copilot, so you must sign
in before the first Analyze.

`copilot login` uses a **browser OAuth flow** (its default auth mode). This means:

- **The one-time code is NOT printed in the terminal.** Authorization happens
  entirely in the browser.
- Running `copilot login` opens your browser to the GitHub authorize page. If the
  browser does not open automatically, copy the URL it prints and open it
  manually, then click **Authorize**.
- On Windows, the login pop-up opened by the app can be hidden behind other
  windows or swallowed by the default terminal host. If you don't see it, run
  `copilot-login.bat` (or
  `node_modules\@github\copilot-win32-x64\copilot.exe login`) from a plain
  `cmd.exe` window — it launches the browser reliably and shows a fallback URL.

The token is stored locally; you only sign in once.

## Note on `.bat` encoding

The helper `.bat` files are written as **pure ASCII with no BOM**. This is
intentional: a UTF-8 BOM at the top of a `.bat` makes `cmd.exe` (whose default
code page is GBK on Chinese Windows) misread the first line (`@echo off`), which
causes the whole script to fail silently and the window to flash-and-close on
double-click. Keeping the files pure ASCII with no BOM lets `cmd.exe` parse them
correctly under any code page. If you add comments, keep them ASCII (English) —
do not introduce Chinese or a BOM, or the flash-and-close bug returns.
