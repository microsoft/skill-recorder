#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Skill Recorder contributors
#
# Builds Skill Recorder locally from an exact source commit on macOS or Ubuntu.
# The script downloads no prebuilt Skill Recorder application.

set -euo pipefail
umask 077

COMMIT="${SKILL_RECORDER_COMMIT:-}"
INSTALL_ROOT="${SKILL_RECORDER_INSTALL_ROOT:-}"
NO_LAUNCH="${SKILL_RECORDER_NO_LAUNCH:-}"
DETACHED="${SKILL_RECORDER_DETACHED:-}"
LOG_KEEP="${SKILL_RECORDER_LOG_KEEP:-5}"

info() { printf '[Skill Recorder] %s\n' "$*"; }
warn() { printf '[Skill Recorder] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[Skill Recorder] ERROR: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

if [[ ! "$COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  die "Set SKILL_RECORDER_COMMIT to the full 40-character release commit SHA."
fi
COMMIT="$(printf '%s' "$COMMIT" | tr 'A-F' 'a-f')"

SYSTEM="$(uname -s)"
MACHINE="$(uname -m)"
case "$SYSTEM" in
  Darwin)
    PLATFORM="darwin"
    DEFAULT_INSTALL_ROOT="$HOME/Library/Application Support/SkillRecorder"
    ;;
  Linux)
    [ -r /etc/os-release ] || die "Ubuntu could not be identified from /etc/os-release."
    OS_ID="$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '"')"
    [ "$OS_ID" = "ubuntu" ] || die "install.sh supports Ubuntu only; found ${OS_ID:-unknown}."
    PLATFORM="linux"
    DEFAULT_INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/SkillRecorder"
    ;;
  *)
    die "install.sh supports macOS and Ubuntu only; found $SYSTEM."
    ;;
esac

case "$MACHINE" in
  x86_64|amd64) ARCHITECTURE="x64" ;;
  arm64|aarch64) ARCHITECTURE="arm64" ;;
  *) die "Unsupported processor architecture: $MACHINE." ;;
esac

INSTALL_ROOT="${INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}"
case "$INSTALL_ROOT" in
  ""|"/"|"$HOME") die "Refusing unsafe installation root: $INSTALL_ROOT." ;;
esac

for command in curl tar; do
  have "$command" || die "$command is required."
done
if ! have shasum && ! have sha256sum; then
  die "shasum or sha256sum is required."
fi

mkdir -p "$INSTALL_ROOT"
INSTALL_ROOT="$(cd "$INSTALL_ROOT" && pwd -P)"
RUNTIME_ROOT="$INSTALL_ROOT/runtime"
VERSIONS_ROOT="$INSTALL_ROOT/versions"
mkdir -p "$RUNTIME_ROOT" "$VERSIONS_ROOT"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/skill-recorder-install.XXXXXX")"
STAGING_DIR=""
cleanup() {
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf -- "$STAGING_DIR"
  fi
  if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

sha256_file() {
  if have shasum; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  else
    sha256sum "$1" | awk '{print tolower($1)}'
  fi
}

download() {
  local uri="$1"
  local destination="$2"
  case "$uri" in
    https://*) ;;
    *) die "Refusing non-HTTPS download: $uri." ;;
  esac
  curl --fail --location --silent --show-error "$uri" --output "$destination"
  [ -s "$destination" ] || die "Download did not create a non-empty file: $uri."
}

checksum_from_manifest() {
  local manifest="$1"
  local file_name="$2"
  awk -v name="$file_name" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$manifest"
}

install_node_runtime() {
  local channel="https://nodejs.org/dist/latest-v24.x"
  local sums="$WORK_DIR/node-SHASUMS256.txt"
  download "$channel/SHASUMS256.txt" "$sums"

  local suffix="-${PLATFORM}-${ARCHITECTURE}.tar.gz"
  local archive_name
  archive_name="$(
    awk -v suffix="$suffix" '
      length($2) >= length(suffix) &&
      substr($2, length($2) - length(suffix) + 1) == suffix {
        print $2
        exit
      }
    ' "$sums"
  )"
  [ -n "$archive_name" ] || die "Node.js 24 did not publish a $PLATFORM-$ARCHITECTURE archive."
  case "$archive_name" in
    node-v24.*-"$PLATFORM"-"$ARCHITECTURE".tar.gz) ;;
    *) die "Unexpected Node.js archive name: $archive_name." ;;
  esac

  local expected_hash
  expected_hash="$(checksum_from_manifest "$sums" "$archive_name")"
  [ -n "$expected_hash" ] || die "Node.js checksums do not list $archive_name."

  local archive_base="${archive_name%.tar.gz}"
  RUNTIME_DIR="$RUNTIME_ROOT/$archive_base"
  NODE="$RUNTIME_DIR/bin/node"
  NPM="$RUNTIME_DIR/bin/npm"

  if [ -x "$NODE" ] &&
     [ -x "$NPM" ] &&
     [ -f "$RUNTIME_DIR/LICENSE" ] &&
     [ "$(cat "$RUNTIME_DIR/.archive-sha256" 2>/dev/null || true)" = "$expected_hash" ] &&
     [ "$(cat "$RUNTIME_DIR/.node-sha256" 2>/dev/null || true)" = "$(sha256_file "$NODE")" ]; then
    info "Using verified portable Node.js runtime $archive_base."
  else
    local archive="$WORK_DIR/$archive_name"
    local extraction="$WORK_DIR/node-extraction"
    info "Downloading official portable Node.js 24 runtime for $PLATFORM-$ARCHITECTURE."
    download "$channel/$archive_name" "$archive"
    local actual_hash
    actual_hash="$(sha256_file "$archive")"
    [ "$actual_hash" = "$expected_hash" ] ||
      die "Node.js archive SHA-256 mismatch. Expected $expected_hash, got $actual_hash."

    rm -rf -- "$RUNTIME_DIR"
    mkdir -p "$extraction"
    tar -xzf "$archive" -C "$extraction"
    [ -d "$extraction/$archive_base" ] ||
      die "Node.js archive did not contain the expected directory."
    mv "$extraction/$archive_base" "$RUNTIME_DIR"
    [ -x "$NODE" ] && [ -x "$NPM" ] && [ -f "$RUNTIME_DIR/LICENSE" ] ||
      die "The extracted Node.js runtime is incomplete."
    printf '%s\n' "$expected_hash" > "$RUNTIME_DIR/.archive-sha256"
    sha256_file "$NODE" > "$RUNTIME_DIR/.node-sha256"
  fi

  PATH="$RUNTIME_DIR/bin:$PATH"
  export PATH
  local node_version node_platform node_architecture
  node_version="$("$NODE" -p 'process.versions.node')"
  node_platform="$("$NODE" -p 'process.platform')"
  node_architecture="$("$NODE" -p 'process.arch')"
  [ "${node_version%%.*}" = "24" ] || die "Expected Node.js 24, got $node_version."
  [ "$node_platform" = "$PLATFORM" ] ||
    die "Expected Node.js platform $PLATFORM, got $node_platform."
  [ "$node_architecture" = "$ARCHITECTURE" ] ||
    die "Expected Node.js architecture $ARCHITECTURE, got $node_architecture."
}

required_install_files() {
  local source_directory="$1"
  local copilot_package="@github/copilot-${PLATFORM}-${ARCHITECTURE}"
  local files="
LICENSE
THIRD-PARTY-NOTICES.md
third_party/compliance-policy.json
node_modules/@github/copilot/LICENSE.md
node_modules/$copilot_package/LICENSE.md
node_modules/electron/dist/LICENSE
node_modules/electron/dist/LICENSES.chromium.html
.compliance/COMPLIANCE-README.md
.compliance/THIRD-PARTY-LICENSES.txt
.compliance/licenses/LGPL-3.0.txt
dist/index.html
dist-electron/main.js
"
  local relative
  while IFS= read -r relative; do
    [ -z "$relative" ] && continue
    [ -e "$source_directory/$relative" ] ||
      die "Installed source is missing required file: $relative."
  done <<EOF
$files
EOF
}

electron_executable() {
  local source_directory="$1"
  if [ "$PLATFORM" = "darwin" ]; then
    printf '%s\n' "$source_directory/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  else
    printf '%s\n' "$source_directory/node_modules/electron/dist/electron"
  fi
}

copilot_executable() {
  local source_directory="$1"
  printf '%s\n' \
    "$source_directory/node_modules/@github/copilot-${PLATFORM}-${ARCHITECTURE}/copilot"
}

validate_existing_install() {
  local source_directory="$1"
  [ "$(cat "$source_directory/.skill-recorder-commit" 2>/dev/null || true)" = "$COMMIT" ] ||
    die "Existing installation metadata does not match commit $COMMIT."
  local lock_hash
  lock_hash="$(sha256_file "$source_directory/package-lock.json")"
  [ "$(cat "$source_directory/.skill-recorder-lock-sha256" 2>/dev/null || true)" = "$lock_hash" ] ||
    die "The existing installation's package-lock.json has changed."

  local electron copilot
  electron="$(electron_executable "$source_directory")"
  copilot="$(copilot_executable "$source_directory")"
  [ -x "$electron" ] || die "The installed Electron executable is missing."
  [ -x "$copilot" ] || die "The installed GitHub Copilot CLI is missing."
  [ "$(cat "$source_directory/.skill-recorder-electron-sha256")" = "$(sha256_file "$electron")" ] ||
    die "The installed Electron executable has changed."
  [ "$(cat "$source_directory/.skill-recorder-copilot-sha256")" = "$(sha256_file "$copilot")" ] ||
    die "The installed GitHub Copilot CLI has changed."
  required_install_files "$source_directory"
}

build_source_install() {
  local source_directory="$1"
  local archive="$WORK_DIR/skill-recorder-$COMMIT.tar.gz"
  info "Downloading Skill Recorder source commit $COMMIT."
  download "https://codeload.github.com/microsoft/skill-recorder/tar.gz/$COMMIT" "$archive"

  local top_directory
  top_directory="$(tar -tzf "$archive" | awk -F/ 'NR == 1 { first = $1 } END { print first }')"
  [ "$top_directory" = "skill-recorder-$COMMIT" ] ||
    die "GitHub source archive did not contain the expected commit directory."

  STAGING_DIR="$VERSIONS_ROOT/.staging-$COMMIT-$$"
  [ ! -e "$STAGING_DIR" ] || die "Staging directory already exists: $STAGING_DIR."
  mkdir -p "$STAGING_DIR"
  tar -xzf "$archive" --strip-components=1 -C "$STAGING_DIR"

  cd "$STAGING_DIR"
  export NPM_CONFIG_REGISTRY="https://registry.npmjs.org/"
  export NPM_CONFIG_CACHE="$INSTALL_ROOT/npm-cache"
  export ELECTRON_MIRROR="https://github.com/electron/electron/releases/download/"

  info "Installing lockfile-pinned dependencies from their publishers."
  "$NPM" ci --no-audit --no-fund

  info "Installing the reviewed Electron runtime."
  "$NODE" "node_modules/electron/install.js"

  local policy_key="$PLATFORM-$ARCHITECTURE"
  local electron_version reviewed_hash
  electron_version="$(
    "$NODE" -e \
      "const p=require('./third_party/compliance-policy.json');process.stdout.write(p.electron.version)"
  )"
  reviewed_hash="$(
    "$NODE" -e \
      "const p=require('./third_party/compliance-policy.json');process.stdout.write(p.electron.distributions[process.argv[1]]||'')" \
      "$policy_key"
  )"
  [ -n "$reviewed_hash" ] ||
    die "No reviewed Electron distribution exists for $policy_key."

  local electron_archive="electron-v${electron_version}-${PLATFORM}-${ARCHITECTURE}.zip"
  local electron_sums="$WORK_DIR/electron-SHASUMS256.txt"
  download \
    "https://github.com/electron/electron/releases/download/v${electron_version}/SHASUMS256.txt" \
    "$electron_sums"
  local official_hash
  official_hash="$(checksum_from_manifest "$electron_sums" "$electron_archive")"
  [ -n "$official_hash" ] ||
    die "Electron's checksum manifest does not list $electron_archive."
  [ "$official_hash" = "$reviewed_hash" ] ||
    die "Electron's official checksum differs from the reviewed compliance policy."
  local bundled_hash
  bundled_hash="$(
    "$NODE" -e \
      "const c=require('./node_modules/electron/checksums.json');process.stdout.write(c[process.argv[1]]||'')" \
      "$electron_archive"
  )"
  [ "$bundled_hash" = "$reviewed_hash" ] ||
    die "Electron's installed checksum manifest differs from the reviewed compliance policy."
  [ "$(cat node_modules/electron/dist/version)" = "$electron_version" ] ||
    die "The installed Electron runtime version is not $electron_version."

  local copilot_package="@github/copilot-${PLATFORM}-${ARCHITECTURE}"
  for required in \
    LICENSE \
    THIRD-PARTY-NOTICES.md \
    third_party/compliance-policy.json \
    node_modules/@github/copilot/LICENSE.md \
    "node_modules/$copilot_package/LICENSE.md" \
    node_modules/electron/dist/LICENSE \
    node_modules/electron/dist/LICENSES.chromium.html; do
    [ -f "$required" ] || die "Dependency installation is missing required legal file: $required."
  done

  local electron copilot
  electron="$(electron_executable "$STAGING_DIR")"
  copilot="$(copilot_executable "$STAGING_DIR")"
  [ -x "$electron" ] || die "Electron did not install its native executable."
  [ -x "$copilot" ] || die "GitHub Copilot CLI did not install its native executable."
  if [ "$PLATFORM" = "linux" ] && have ldd; then
    local missing_libraries
    missing_libraries="$(ldd "$electron" | awk '/not found/ { print $1 }')"
    [ -z "$missing_libraries" ] ||
      die "Electron requires missing Ubuntu libraries: $missing_libraries"
  fi

  info "Generating and validating platform license materials."
  "$NPM" run compliance:licenses
  [ -f .compliance/licenses/LGPL-3.0.txt ] ||
    die "The canonical LGPL-3.0 text was not generated."

  info "Building Skill Recorder locally."
  "$NPM" run build

  printf '%s\n' "$COMMIT" > .skill-recorder-commit
  sha256_file package-lock.json > .skill-recorder-lock-sha256
  sha256_file "$electron" > .skill-recorder-electron-sha256
  sha256_file "$copilot" > .skill-recorder-copilot-sha256

  [ ! -e "$source_directory" ] ||
    die "Installation directory appeared while building: $source_directory."
  mv "$STAGING_DIR" "$source_directory"
  STAGING_DIR=""
}

write_macos_app() {
  local launcher="$1"
  local applications="$HOME/Applications"
  local bundle="$applications/Skill Recorder (Source).app"
  local contents="$bundle/Contents"
  local macos_dir="$contents/MacOS"
  local executable_name="skill-recorder-source"
  local stub="$macos_dir/$executable_name"
  local plist="$contents/Info.plist"
  local stub_temporary plist_temporary

  mkdir -p "$applications"
  rm -rf -- "$bundle"
  mkdir -p "$macos_dir"

  stub_temporary="$macos_dir/.skill-recorder-source.$$"
  {
    printf '%s\n' '#!/bin/bash'
    printf 'exec %q "$@"\n' "$launcher"
  } > "$stub_temporary"
  chmod 755 "$stub_temporary"
  mv -f "$stub_temporary" "$stub"

  plist_temporary="$contents/.Info.plist.$$"
  {
    printf '%s\n' \
      '<?xml version="1.0" encoding="UTF-8"?>' \
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
      '<plist version="1.0">' \
      '<dict>' \
      '  <key>CFBundleName</key>' \
      '  <string>Skill Recorder (Source)</string>' \
      '  <key>CFBundleDisplayName</key>' \
      '  <string>Skill Recorder (Source)</string>' \
      '  <key>CFBundleIdentifier</key>' \
      '  <string>com.skillrecorder.source</string>' \
      '  <key>CFBundleExecutable</key>' \
      "  <string>$executable_name</string>" \
      '  <key>CFBundlePackageType</key>' \
      '  <string>APPL</string>' \
      '  <key>CFBundleShortVersionString</key>' \
      '  <string>1.0</string>' \
      '  <key>CFBundleVersion</key>' \
      '  <string>1.0</string>' \
      '  <key>LSMinimumSystemVersion</key>' \
      '  <string>10.15</string>' \
      '  <key>NSHighResolutionCapable</key>' \
      '  <true/>' \
      '</dict>' \
      '</plist>'
  } > "$plist_temporary"
  chmod 644 "$plist_temporary"
  mv -f "$plist_temporary" "$plist"

  APP_BUNDLE="$bundle"
}

write_launcher() {
  local source_directory="$1"
  local electron="$2"
  local launcher="$INSTALL_ROOT/skill-recorder-source"
  local temporary="$INSTALL_ROOT/.skill-recorder-source.$$"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
    printf 'SOURCE_DIRECTORY=%q\n' "$source_directory"
    printf 'ELECTRON_EXECUTABLE=%q\n' "$electron"
    printf 'exec "$ELECTRON_EXECUTABLE" "$SOURCE_DIRECTORY" "$@"\n'
  } > "$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$launcher"
  LAUNCHER="$launcher"

  if [ "$PLATFORM" = "linux" ]; then
    local applications="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    local desktop="$applications/skill-recorder-source.desktop"
    local desktop_temporary="$applications/.skill-recorder-source.desktop.$$"
    mkdir -p "$applications"
    {
      printf '%s\n' \
        '[Desktop Entry]' \
        'Type=Application' \
        'Name=Skill Recorder (Source)' \
        'Comment=Skill Recorder built locally from pinned source'
      printf 'Exec="%s"\n' "$launcher"
      printf '%s\n' \
        'Icon=applications-development' \
        'Terminal=false' \
        'Categories=Development;'
    } > "$desktop_temporary"
    chmod 644 "$desktop_temporary"
    mv -f "$desktop_temporary" "$desktop"
    DESKTOP_ENTRY="$desktop"
  fi

  if [ "$PLATFORM" = "darwin" ]; then
    write_macos_app "$launcher"
  fi
}

install_node_runtime

SOURCE_DIR="$VERSIONS_ROOT/$COMMIT"
if [ -d "$SOURCE_DIR" ]; then
  info "Using the existing source installation for commit $COMMIT."
else
  build_source_install "$SOURCE_DIR"
fi

validate_existing_install "$SOURCE_DIR"
ELECTRON_EXECUTABLE="$(electron_executable "$SOURCE_DIR")"
write_launcher "$SOURCE_DIR" "$ELECTRON_EXECUTABLE"

info "Installed commit $COMMIT at $SOURCE_DIR."
info "License materials remain in the source tree, dependency packages, and .compliance directory."
info "Launcher: $LAUNCHER"
if [ -n "${DESKTOP_ENTRY:-}" ]; then
  info "Ubuntu desktop entry: $DESKTOP_ENTRY"
fi
if [ -n "${APP_BUNDLE:-}" ]; then
  info "macOS app: $APP_BUNDLE"
fi
warn "This locally generated build is for local execution only. Do not redistribute it."

rm -rf -- "$WORK_DIR"
WORK_DIR=""

if [ "$NO_LAUNCH" = "1" ]; then
  info "SKILL_RECORDER_NO_LAUNCH=1; not launching."
  exit 0
fi

if [ -n "$DETACHED" ]; then
  case "$LOG_KEEP" in
    ""|*[!0-9]*) LOG_KEEP=5 ;;
  esac
  [ "$LOG_KEEP" -ge 1 ] || LOG_KEEP=1
  LOG_DIR="$INSTALL_ROOT/logs"
  mkdir -p "$LOG_DIR"
  {
    ls -1t "$LOG_DIR"/skill-recorder-*.log 2>/dev/null || true
  } | tail -n +"$LOG_KEEP" | while IFS= read -r old_log; do
    rm -f -- "$old_log"
  done
  LOG_FILE="$LOG_DIR/skill-recorder-$(date +%Y%m%d-%H%M%S).log"
  nohup "$LAUNCHER" </dev/null >"$LOG_FILE" 2>&1 &
  info "Running in the background as process $!. Logs: $LOG_FILE"
  exit 0
fi

info "Launching Skill Recorder."
exec "$LAUNCHER"
