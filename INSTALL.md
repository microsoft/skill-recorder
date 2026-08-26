# Installing Skill Recorder from source

Skill Recorder can run directly from an exact source revision on Windows, macOS,
or Ubuntu. These methods do not download a prebuilt Skill Recorder application.
Node.js, Electron, native dependencies, and the GitHub Copilot CLI are obtained
from canonical upstreams or compatible configured registries and assembled
locally.

The generated build is for local execution only. Do not redistribute the build,
`node_modules`, or downloaded runtimes. Release binaries must use the
repository's `npm run dist*` commands and include the complete generated
compliance bundle.

## Commit-pinned one-line installation

Replace `<40-character-release-commit>` with the full 40-character commit SHA
published for the release.

### Windows 11 x64 or ARM64

```powershell
$commit="<40-character-release-commit>"; $env:SKILL_RECORDER_COMMIT=$commit; irm "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.ps1" | iex
```

### macOS or Ubuntu

```sh
commit="<40-character-release-commit>"; curl -fsSL "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.sh" | SKILL_RECORDER_COMMIT="$commit" bash
```

To launch in the background and retain rolling logs on macOS or Ubuntu:

```sh
commit="<40-character-release-commit>"; curl -fsSL "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.sh" | SKILL_RECORDER_COMMIT="$commit" SKILL_RECORDER_DETACHED=1 bash
```

The commit appears twice deliberately: it pins both the script being executed
and the source that the script builds. Never replace it with `master`, `main`, a
branch name, or an unverified tag.

The source installers:

1. Require a full commit SHA and reject mutable references.
2. Select the native x64 or ARM64 architecture and reject unsupported operating
   systems. `install.sh` accepts macOS and Ubuntu only.
3. Download an official portable Node.js 24 runtime from `nodejs.org` and verify
   its archive against Node.js's `SHASUMS256.txt`. Windows additionally verifies
   the OpenJS Foundation Authenticode signature.
4. Download only the exact source commit from GitHub Codeload.
5. Validate that the lockfile contains canonical npmjs URLs, run `npm ci` through
   the user's configured registry or compatible mirror, install Electron from its
   official release endpoint, and confirm Electron's official checksum manifest
   matches the reviewed compliance policy.
6. Run `npm run compliance:licenses` and fail if any installed platform package
   lacks reviewed legal material.
7. Build locally, retain repository/dependency licenses, and record hashes for
   the installed Electron and Copilot executables.
8. Create Start Menu **and** desktop shortcuts on Windows; a launcher plus a
   `Skill Recorder (Source)` app in `~/Applications` (reachable from Spotlight,
   Launchpad, and the Dock) on macOS; and a launcher plus desktop entry on Ubuntu.
9. Print a final confirmation listing the shortcuts that were created.

No administrator access, global Node.js installation, or global Copilot CLI
installation is required. GitHub Copilot authentication, entitlement, and
network access are still required.

Piping a downloaded script directly to a shell gives you no opportunity to
inspect it first and may be disabled by enterprise policy. The inspect-first
procedures below are preferred.

Source installation is not a security-policy bypass. Gatekeeper, Smart App
Control, application-control policy, or endpoint protection may still block
downloaded or locally assembled components.

## Inspect-first installation

Compare the displayed script SHA-256 with the value published in the
corresponding GitHub Release before executing it.

### Windows

```powershell
$commit = "<40-character-release-commit>"
$script = Join-Path $env:TEMP "skill-recorder-install-$commit.ps1"
Invoke-WebRequest "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.ps1" -OutFile $script -UseBasicParsing
Get-FileHash $script -Algorithm SHA256
Get-Content $script
$env:SKILL_RECORDER_COMMIT = $commit
& $script
```

### macOS

```sh
commit="<40-character-release-commit>"
script="$(mktemp -t skill-recorder-install.XXXXXX)"
curl -fsSL "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.sh" -o "$script"
shasum -a 256 "$script"
cat "$script"
SKILL_RECORDER_COMMIT="$commit" bash "$script"
rm -f "$script"
```

### Ubuntu

```sh
commit="<40-character-release-commit>"
script="$(mktemp --suffix=.sh)"
curl -fsSL "https://raw.githubusercontent.com/microsoft/skill-recorder/$commit/install.sh" -o "$script"
sha256sum "$script"
cat "$script"
SKILL_RECORDER_COMMIT="$commit" bash "$script"
rm -f "$script"
```

## Source-installer options and locations

| Variable | Platforms | Meaning |
| --- | --- | --- |
| `SKILL_RECORDER_COMMIT` | all | Required full 40-character source commit |
| `SKILL_RECORDER_INSTALL_ROOT` | all | Override the per-user source/runtime directory |
| `SKILL_RECORDER_NO_LAUNCH=1` | all | Install and validate without launching |
| `SKILL_RECORDER_NO_DESKTOP_SHORTCUT=1` | Windows | Create only the Start Menu shortcut |
| `SKILL_RECORDER_DETACHED=1` | macOS, Ubuntu | Launch in the background with file logging |
| `SKILL_RECORDER_LOG_KEEP` | macOS, Ubuntu | Number of detached launch logs to retain; default `5` |

Default installation roots:

- Windows: `%LOCALAPPDATA%\SkillRecorder`
- macOS: `~/Library/Application Support/SkillRecorder`
- Ubuntu: `${XDG_DATA_HOME:-~/.local/share}/SkillRecorder`

Every revision is installed under `versions/<commit>`. The current launcher is
updated only after the selected revision passes dependency, license, integrity,
and build checks.

## Re-running the same command

Running the Windows command again with the same commit does not download or
rebuild anything. The installer verifies the existing `versions/<commit>`
installation, refreshes the Start Menu and desktop shortcuts, and launches.

If an earlier attempt failed part-way, the portable Node.js archive and the
source archive it had already fetched are kept in `<install root>\cache` and
reused on the next attempt. Cached files are re-verified by SHA-256 before use —
the Node.js archive against the checksums published by nodejs.org on every run —
and are deleted once the revision is installed. Deleting the `cache` directory is
always safe.

## Relaunching after it closes

After a successful install you can reopen Skill Recorder without re-running the
installer:

- Windows: the **Skill Recorder (Source)** desktop shortcut, or the matching
  Start Menu entry.
- macOS: **Skill Recorder (Source)** in `~/Applications`, searchable from
  Spotlight and Launchpad and pinnable to the Dock.
- Ubuntu: the **Skill Recorder (Source)** desktop entry, or run the launcher
  script directly.

Each entry runs the current launcher, so it always starts the most recently
installed revision.

## Manual developer setup

Install Node.js 24.19 or newer within the Node.js 24 release line from its
official publisher. This supplies npm 11.17 or newer, which is required to
enforce the reviewed dependency lifecycle-script policy. Download the exact
commit archive rather than repository history.

### Windows PowerShell

```powershell
$commit = "<40-character-release-commit>"
$archive = Join-Path $env:TEMP "skill-recorder-$commit.zip"
$parent = Join-Path $PWD "skill-recorder-source"
Invoke-WebRequest "https://codeload.github.com/microsoft/skill-recorder/zip/$commit" -OutFile $archive -UseBasicParsing
Expand-Archive $archive $parent
Set-Location (Join-Path $parent "skill-recorder-$commit")
npm run check:lockfile
npm ci --ignore-scripts=false --dangerously-allow-all-scripts=false --strict-allow-scripts
npm run electron:install-reviewed
npm run compliance:licenses
npm run build
npm start
```

### macOS

```sh
commit="<40-character-release-commit>"
archive="skill-recorder-$commit.tar.gz"
source_dir="skill-recorder-$commit"
curl -fsSL "https://codeload.github.com/microsoft/skill-recorder/tar.gz/$commit" -o "$archive"
mkdir "$source_dir"
tar -xzf "$archive" --strip-components=1 -C "$source_dir"
cd "$source_dir"
npm run check:lockfile
npm ci --ignore-scripts=false --dangerously-allow-all-scripts=false --strict-allow-scripts
npm run electron:install-reviewed
npm run compliance:licenses
npm run build
npm start
```

### Ubuntu

Install the basic archive/download tools if the machine does not already have
them:

```sh
sudo apt-get update
sudo apt-get install --yes ca-certificates curl tar
```

Then use the same pinned source process:

```sh
commit="<40-character-release-commit>"
archive="skill-recorder-$commit.tar.gz"
source_dir="skill-recorder-$commit"
curl -fsSL "https://codeload.github.com/microsoft/skill-recorder/tar.gz/$commit" -o "$archive"
mkdir "$source_dir"
tar -xzf "$archive" --strip-components=1 -C "$source_dir"
cd "$source_dir"
npm run check:lockfile
npm ci --ignore-scripts=false --dangerously-allow-all-scripts=false --strict-allow-scripts
npm run electron:install-reviewed
npm run compliance:licenses
npm run build
npm start
```

For hot-reload development, run `npm run dev` after the validated install
sequence above and `npm run compliance:licenses`.

The lockfile pins the dependency graph with canonical `registry.npmjs.org` URLs
and integrity hashes. npm may map those URLs to a configured compatible
corporate registry. Use `npm ci`, not `npm install`, and do not regenerate the
lockfile during installation. Keep the entire checkout, `.compliance`, and
dependency legal files.

### Networks that block registry.npmjs.org

The installers run a portable Node.js runtime that is unpacked into the
installation root. Because Node.js's portable archives ship no builtin npmrc,
npm would resolve its global configuration inside that throwaway runtime
directory and ignore the registry configured for the machine. The installers
therefore locate the machine's real global npmrc and pass it to the portable npm
so that `replace-registry-host` maps the lockfile's canonical npmjs URLs onto the
configured mirror. Machines with no npm configuration are unaffected and continue
to use `registry.npmjs.org`.

Configure a mirror once with:

```sh
npm config set registry <url> --location=global
```

The installers never pin or override the registry themselves; they only make the
machine's existing npm configuration visible to the portable runtime. The
lockfile's integrity hashes are verified whichever registry serves the packages,
so a mirror cannot substitute different content.

## Licensing boundary

The source channels distribute this repository's MIT-licensed source. The
user's package manager obtains Sharp/libvips, ONNX Runtime, Tesseract.js, the
unmodified GitHub Copilot CLI, and other npm dependencies through its configured registry;
the installer obtains the reviewed Electron runtime from GitHub. Canonical
registry URLs and integrity hashes keep the lockfile portable across direct
npmjs access and compatible corporate mirrors. The local build is not a
redistributable application package.

Each platform's compliance check retains:

- `LICENSE` and `THIRD-PARTY-NOTICES.md`;
- complete license files installed with npm packages, including the Copilot CLI
  license;
- Electron and Chromium runtime notices;
- canonical GPL, LGPL, MPL, and Artistic-2.0 texts under `.compliance/licenses`;
- platform-specific Sharp/libvips and ONNX Runtime notices under `.compliance`;
- Tesseract WebAssembly component notices under `.compliance/tesseract-core`;
- an inventory with no unresolved dependency-license entries.

Anyone redistributing a generated application must instead use the supported
`npm run dist*` pipeline. It packages the exact notices, corresponding source,
patches, hashes, and relinking instructions required by the bundled libraries.

## Updating and uninstalling

To update, rerun the source installer with the new release's full commit SHA.
Test the new revision before deleting an older revision.

### Windows uninstall

```powershell
Remove-Item "$([Environment]::GetFolderPath('Programs'))\Skill Recorder (Source).lnk" -Force
Remove-Item "$([Environment]::GetFolderPath('DesktopDirectory'))\Skill Recorder (Source).lnk" -Force
Remove-Item "$env:LOCALAPPDATA\SkillRecorder" -Recurse -Force
```

### macOS uninstall

```sh
rm -rf "$HOME/Applications/Skill Recorder (Source).app"
rm -rf "$HOME/Library/Application Support/SkillRecorder"
```

### Ubuntu uninstall

```sh
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -f "$data_home/applications/skill-recorder-source.desktop"
rm -rf "$data_home/SkillRecorder"
```

These commands leave recorded-session/application data outside the source
installation root intact.

## Release maintainer checklist

The complete repeatable process is documented in
[`RELEASING.md`](RELEASING.md).

1. Confirm all contributors and employers have authorized the MIT release.
2. Build and test the exact release commit on every advertised native platform
   and architecture.
3. Confirm Windows, macOS, and Ubuntu CI produce a license inventory with no
   unresolved entries.
4. Publish the full commit SHA, never a branch name, in installation commands.
5. Publish SHA-256 values for that commit's `install.ps1` and `install.sh`.
6. Protect the release tag from movement or deletion.
7. Test the one-line and inspect-first source paths on clean machines.
8. Do not mirror or repackage Node.js, Electron, npm dependencies, or Copilot
   binaries in the source-install channel.
9. For any prebuilt release, use `npm run dist*` and publish the complete,
   version-matched compliance materials.
