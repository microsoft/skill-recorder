# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Skill Recorder contributors

<#
.SYNOPSIS
Builds and installs Skill Recorder from an exact source commit.

.DESCRIPTION
This script does not download a prebuilt Skill Recorder application. It obtains
an official portable Node.js 24 runtime, downloads the exact requested source
commit from GitHub, installs lockfile-pinned dependencies from their publishers,
validates license materials, builds locally, and creates Start Menu and desktop
shortcuts.

Re-running the same commit reuses the verified installation instead of
downloading and rebuilding it again. Downloads interrupted by an earlier failed
run are resumed from a checksum-verified cache rather than fetched twice.
#>

& {
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Commit = $env:SKILL_RECORDER_COMMIT
$InstallRoot = $env:SKILL_RECORDER_INSTALL_ROOT
$skipLaunch = $env:SKILL_RECORDER_NO_LAUNCH -eq "1"
$createDesktopShortcut = $env:SKILL_RECORDER_NO_DESKTOP_SHORTCUT -ne "1"

function Write-Step {
  param([Parameter(Mandatory)][string]$Message)
  Write-Host "[Skill Recorder] $Message"
}

function Invoke-Download {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [Parameter(Mandatory)][string]$Destination
  )

  $parsedUri = [Uri]$Uri
  if ($parsedUri.Scheme -ne "https") {
    throw "Refusing non-HTTPS download: $Uri"
  }

  $parameters = @{
    Uri = $Uri
    OutFile = $Destination
    Headers = @{ "User-Agent" = "Skill-Recorder-Source-Installer" }
  }
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    $parameters.UseBasicParsing = $true
  }

  $previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest @parameters
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
  }
  if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
    throw "Download did not create $Destination"
  }
  if ((Get-Item -LiteralPath $Destination).Length -eq 0) {
    throw "Downloaded file is empty: $Uri"
  }
}

function Get-CachedDownload {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [Parameter(Mandatory)][string]$CachePath,
    [string]$ExpectedSha256
  )

  $digestPath = "$CachePath.sha256"
  $expected = ""
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    $expected = $ExpectedSha256.ToLowerInvariant()
  }

  if (Test-Path -LiteralPath $CachePath -PathType Leaf) {
    $reference = $expected
    if ([string]::IsNullOrWhiteSpace($reference) -and (Test-Path -LiteralPath $digestPath -PathType Leaf)) {
      $reference = (Get-Content -LiteralPath $digestPath -Raw).Trim().ToLowerInvariant()
    }

    $cachedHash = (Get-FileHash -LiteralPath $CachePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($reference -match "^[0-9a-f]{64}$" -and $cachedHash -eq $reference) {
      Write-Step "Reusing the cached download $(Split-Path -Leaf $CachePath) instead of downloading it again."
      return $cachedHash
    }

    Write-Step "Discarding an unverifiable cached download: $(Split-Path -Leaf $CachePath)"
    Remove-Item -LiteralPath $CachePath -Force
    if (Test-Path -LiteralPath $digestPath -PathType Leaf) {
      Remove-Item -LiteralPath $digestPath -Force
    }
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $CachePath) -Force | Out-Null
  Invoke-Download -Uri $Uri -Destination $CachePath
  $downloadHash = (Get-FileHash -LiteralPath $CachePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($expected) -and $downloadHash -ne $expected) {
    Remove-Item -LiteralPath $CachePath -Force
    throw "Download SHA-256 mismatch for $Uri. Expected $expected, got $downloadHash."
  }

  Set-Content -LiteralPath $digestPath -Value $downloadHash -Encoding ASCII
  return $downloadHash
}

function Remove-CachedDownload {
  param([Parameter(Mandatory)][string]$CachePath)

  foreach ($path in @($CachePath, "$CachePath.sha256")) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

function Assert-ZipArchive {
  param([Parameter(Mandatory)][string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  try {
    $header = New-Object byte[] 4
    if ($stream.Read($header, 0, $header.Length) -ne $header.Length) {
      throw "Archive is too short: $Path"
    }
    if (
      $header[0] -ne 0x50 -or
      $header[1] -ne 0x4b -or
      $header[2] -ne 0x03 -or
      $header[3] -ne 0x04
    ) {
      throw "Downloaded file is not a ZIP archive: $Path"
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-TrustedSignature {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$PublisherPattern,
    [Parameter(Mandatory)][string]$PublisherName
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required executable is missing: $Path"
  }

  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ([string]$signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
    throw "$PublisherName signature is not valid for $Path (status: $($signature.Status))."
  }
  if ($signature.SignerCertificate.Subject -notmatch $PublisherPattern) {
    throw "Unexpected signer for ${Path}: $($signature.SignerCertificate.Subject)"
  }
}

function Assert-RequiredPaths {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string[]]$RelativePaths
  )

  foreach ($relativePath in $RelativePaths) {
    $candidate = Join-Path $Root $relativePath
    if (-not (Test-Path -LiteralPath $candidate)) {
      throw "Required installation material is missing: $relativePath"
    }
  }
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$Description
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Get-WindowsArchitecture {
  $architecture = [Environment]::GetEnvironmentVariable(
    "PROCESSOR_ARCHITECTURE",
    [EnvironmentVariableTarget]::Machine
  )
  if ([string]::IsNullOrWhiteSpace($architecture)) {
    $architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432")
  }
  if ([string]::IsNullOrWhiteSpace($architecture)) {
    $architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
  }
  if ([string]::IsNullOrWhiteSpace($architecture)) {
    throw "Windows did not report its native processor architecture."
  }

  switch ($architecture.ToUpperInvariant()) {
    "AMD64" { return "x64" }
    "ARM64" { return "arm64" }
    default {
      throw "Skill Recorder supports Windows x64 and ARM64, not $architecture."
    }
  }
}

function Get-ElectronExecutable {
  param([Parameter(Mandatory)][string]$SourceDirectory)

  Assert-RequiredPaths -Root $SourceDirectory -RelativePaths @(
    "node_modules\electron\package.json",
    "node_modules\electron\checksums.json",
    "node_modules\electron\dist\electron.exe",
    "node_modules\electron\dist\version",
    "node_modules\electron\dist\LICENSE",
    "node_modules\electron\dist\LICENSES.chromium.html"
  )

  $package = Get-Content `
    -LiteralPath (Join-Path $SourceDirectory "node_modules\electron\package.json") `
    -Raw | ConvertFrom-Json
  $distVersion = (
    Get-Content -LiteralPath (Join-Path $SourceDirectory "node_modules\electron\dist\version") -Raw
  ).Trim().TrimStart("v")
  if ([string]$package.version -ne $distVersion) {
    throw "Electron runtime version mismatch. Expected $($package.version), got $distVersion."
  }

  return Join-Path $SourceDirectory "node_modules\electron\dist\electron.exe"
}

function Assert-ReviewedElectronDistribution {
  param(
    [Parameter(Mandatory)][string]$SourceDirectory,
    [Parameter(Mandatory)][string]$Architecture
  )

  Assert-RequiredPaths -Root $SourceDirectory -RelativePaths @(
    "node_modules\electron\package.json",
    "node_modules\electron\checksums.json",
    "third_party\compliance-policy.json"
  )

  $electronPackage = Get-Content `
    -LiteralPath (Join-Path $SourceDirectory "node_modules\electron\package.json") `
    -Raw | ConvertFrom-Json
  $electronChecksums = Get-Content `
    -LiteralPath (Join-Path $SourceDirectory "node_modules\electron\checksums.json") `
    -Raw | ConvertFrom-Json
  $policy = Get-Content `
    -LiteralPath (Join-Path $SourceDirectory "third_party\compliance-policy.json") `
    -Raw | ConvertFrom-Json

  if ([string]$electronPackage.version -ne [string]$policy.electron.version) {
    throw "Installed Electron version has not been reviewed by the compliance policy."
  }

  $archiveName = "electron-v$($electronPackage.version)-win32-$Architecture.zip"
  $manifestProperty = $electronChecksums.PSObject.Properties[$archiveName]
  if ($null -eq $manifestProperty) {
    throw "Electron's checksum manifest does not list $archiveName."
  }

  $distributionKey = "win32-$Architecture"
  $reviewedProperty = $policy.electron.distributions.PSObject.Properties[$distributionKey]
  if ($null -eq $reviewedProperty) {
    throw "The compliance policy does not review Electron for $distributionKey."
  }

  $manifestHash = ([string]$manifestProperty.Value).ToLowerInvariant()
  $reviewedHash = ([string]$reviewedProperty.Value).ToLowerInvariant()
  if ($manifestHash -ne $reviewedHash) {
    throw "Electron's checksum manifest does not match the reviewed distribution hash."
  }
}

function Get-NodeRuntime {
  param(
    [Parameter(Mandatory)][string]$Architecture,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$StagingRoot,
    [Parameter(Mandatory)][string]$CacheRoot
  )

  Write-Step "Resolving the latest Node.js 24 LTS release for Windows $Architecture."
  $indexPath = Join-Path $StagingRoot "node-index.json"
  Invoke-Download -Uri "https://nodejs.org/dist/index.json" -Destination $indexPath
  $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
  $fileKind = "win-$Architecture-zip"
  $compatibleReleases = @(
    foreach ($release in $index) {
      if (
        $release.version -match "^v24\.\d+\.\d+$" -and
        [bool]$release.lts -and
        $release.files -contains $fileKind
      ) {
        $release
      }
    }
  )
  if ($compatibleReleases.Count -eq 0) {
    throw "Node.js did not publish a Node 24 archive for Windows $Architecture."
  }

  $version = [string]$compatibleReleases[0].version
  $archiveName = "node-$version-win-$Architecture.zip"
  $runtimeDirectory = Join-Path $RuntimeRoot ([IO.Path]::GetFileNameWithoutExtension($archiveName))
  $nodeExe = Join-Path $runtimeDirectory "node.exe"
  $npmCmd = Join-Path $runtimeDirectory "npm.cmd"

  if (-not (Test-Path -LiteralPath $runtimeDirectory -PathType Container)) {
    $archivePath = Join-Path $CacheRoot $archiveName
    $sumsPath = Join-Path $StagingRoot "SHASUMS256.txt"
    $baseUri = "https://nodejs.org/dist/$version"
    Invoke-Download -Uri "$baseUri/SHASUMS256.txt" -Destination $sumsPath

    $hashPattern = "(?m)^([0-9a-fA-F]{64})\s+" + [regex]::Escape($archiveName) + "\s*$"
    $hashMatch = [regex]::Match((Get-Content -LiteralPath $sumsPath -Raw), $hashPattern)
    if (-not $hashMatch.Success) {
      throw "Official Node.js checksums do not list $archiveName."
    }
    $expectedHash = $hashMatch.Groups[1].Value.ToLowerInvariant()

    Write-Step "Obtaining $archiveName from nodejs.org."
    $actualHash = Get-CachedDownload `
      -Uri "$baseUri/$archiveName" `
      -CachePath $archivePath `
      -ExpectedSha256 $expectedHash
    Assert-ZipArchive -Path $archivePath

    if ($actualHash -ne $expectedHash) {
      throw "Node.js archive SHA-256 mismatch. Expected $expectedHash, got $actualHash."
    }

    $expandedRoot = Join-Path $StagingRoot "node-expanded"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedRoot
    $expandedDirectory = Join-Path $expandedRoot ([IO.Path]::GetFileNameWithoutExtension($archiveName))
    Assert-TrustedSignature `
      -Path (Join-Path $expandedDirectory "node.exe") `
      -PublisherPattern "OpenJS Foundation" `
      -PublisherName "OpenJS Foundation"
    Assert-RequiredPaths -Root $expandedDirectory -RelativePaths @("LICENSE", "npm.cmd")

    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    Move-Item -LiteralPath $expandedDirectory -Destination $runtimeDirectory
    Remove-CachedDownload -CachePath $archivePath
  } else {
    Write-Step "Reusing the verified Node.js $version runtime already installed at $runtimeDirectory."
  }

  Assert-TrustedSignature `
    -Path $nodeExe `
    -PublisherPattern "OpenJS Foundation" `
    -PublisherName "OpenJS Foundation"
  Assert-RequiredPaths -Root $runtimeDirectory -RelativePaths @("LICENSE", "npm.cmd")

  $versionOutput = @(& $nodeExe --version)
  $versionExitCode = $LASTEXITCODE
  $reportedVersion = ($versionOutput -join "`n").Trim()
  if ($versionExitCode -ne 0 -or $reportedVersion -ne $version) {
    throw "Node.js runtime version mismatch. Expected $version, got $reportedVersion."
  }
  $architectureOutput = @(& $nodeExe -p "process.arch")
  $architectureExitCode = $LASTEXITCODE
  $reportedArchitecture = ($architectureOutput -join "`n").Trim()
  if ($architectureExitCode -ne 0 -or $reportedArchitecture -ne $Architecture) {
    throw "Node.js runtime architecture mismatch. Expected $Architecture, got $reportedArchitecture."
  }

  return [pscustomobject]@{
    Version = $version
    Root = $runtimeDirectory
    Node = $nodeExe
    Npm = $npmCmd
  }
}

function Get-ShortcutFolder {
  param(
    [Parameter(Mandatory)][string]$SpecialFolder,
    [Parameter(Mandatory)][string]$Description
  )

  $folder = [Environment]::GetFolderPath([Environment+SpecialFolder]$SpecialFolder)
  if ([string]::IsNullOrWhiteSpace($folder)) {
    throw "The current user does not have a $Description directory."
  }
  if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
  }
  return $folder
}

function New-SourceShortcut {
  param(
    [Parameter(Mandatory)][string]$Folder,
    [Parameter(Mandatory)][string]$SourceDirectory,
    [Parameter(Mandatory)][string]$ElectronExecutable
  )

  $shortcutPath = Join-Path $Folder "Skill Recorder (Source).lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $ElectronExecutable
  $shortcut.Arguments = '"' + $SourceDirectory + '"'
  $shortcut.WorkingDirectory = $SourceDirectory
  $shortcut.IconLocation = "$ElectronExecutable,0"
  $shortcut.Description = "Skill Recorder built locally from pinned source"
  $shortcut.Save()
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    throw "Windows did not create the shortcut at $shortcutPath."
  }
  return $shortcutPath
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "install.ps1 supports Windows only. Use the manual source instructions in INSTALL.md elsewhere."
}
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
  throw "PowerShell 5.1 or newer is required."
}
if ([string]::IsNullOrWhiteSpace($Commit) -or $Commit -notmatch "^[0-9a-fA-F]{40}$") {
  throw "Set SKILL_RECORDER_COMMIT to the full 40-character release commit SHA."
}

$Commit = $Commit.ToLowerInvariant()
$architecture = Get-WindowsArchitecture

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is unavailable. Set SKILL_RECORDER_INSTALL_ROOT explicitly."
  }
  $InstallRoot = Join-Path $env:LOCALAPPDATA "SkillRecorder"
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)

$runtimeRoot = Join-Path $InstallRoot "runtime"
$versionsRoot = Join-Path $InstallRoot "versions"
$cacheRoot = Join-Path $InstallRoot "cache"
$sourceDirectory = Join-Path $versionsRoot $Commit
$metadataPath = Join-Path $sourceDirectory ".skill-recorder-install.json"
$platformPackage = "@github\copilot-win32-$architecture"

New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null

if (Test-Path -LiteralPath $sourceDirectory -PathType Container) {
  Write-Step "Commit $Commit is already installed; reusing it without downloading or rebuilding anything."
  if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "The existing source directory has no installation metadata: $sourceDirectory"
  }

  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  if ([string]$metadata.commit -ne $Commit) {
    throw "Existing installation metadata does not match commit $Commit."
  }
  $lockHash = (Get-FileHash -LiteralPath (Join-Path $sourceDirectory "package-lock.json") -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($lockHash -ne [string]$metadata.packageLockSha256) {
    throw "The existing installation's package-lock.json has changed."
  }
} else {
  $stagingDirectory = Join-Path $InstallRoot (".staging-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

  try {
    $runtime = Get-NodeRuntime `
      -Architecture $architecture `
      -RuntimeRoot $runtimeRoot `
      -StagingRoot $stagingDirectory `
      -CacheRoot $cacheRoot

    Write-Step "Obtaining the exact source commit from GitHub."
    $sourceArchive = Join-Path $cacheRoot "skill-recorder-$Commit.zip"
    $sourceArchiveHash = Get-CachedDownload `
      -Uri "https://codeload.github.com/microsoft/skill-recorder/zip/$Commit" `
      -CachePath $sourceArchive
    Assert-ZipArchive -Path $sourceArchive

    $sourceExtractRoot = Join-Path $stagingDirectory "source"
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceExtractRoot
    $sourceCandidates = @(
      Get-ChildItem -LiteralPath $sourceExtractRoot -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "package.json") -PathType Leaf }
    )
    if ($sourceCandidates.Count -ne 1) {
      throw "Expected one Skill Recorder source directory, found $($sourceCandidates.Count)."
    }
    $expectedSourceDirectoryName = "skill-recorder-$Commit"
    if ($sourceCandidates[0].Name -ne $expectedSourceDirectoryName) {
      throw "GitHub source directory does not match commit $Commit."
    }
    $buildDirectory = $sourceCandidates[0].FullName

    Assert-RequiredPaths -Root $buildDirectory -RelativePaths @(
      "LICENSE",
      "THIRD-PARTY-NOTICES.md",
      "CONTRIBUTING.md",
      "package.json",
      "package-lock.json"
    )

    Write-Step "Installing lockfile-pinned dependencies from their publishers."
    $environmentOverrides = [ordered]@{
      PATH = "$($runtime.Root);$env:PATH"
      NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/"
      NPM_CONFIG_REPLACE_REGISTRY_HOST = "never"
      NPM_CONFIG_PLATFORM = "win32"
      NPM_CONFIG_ARCH = $architecture
      ELECTRON_MIRROR = "https://github.com/electron/electron/releases/download/"
      NPM_CONFIG_ELECTRON_MIRROR = "https://github.com/electron/electron/releases/download/"
      ELECTRON_INSTALL_PLATFORM = "win32"
      ELECTRON_INSTALL_ARCH = $architecture
      ELECTRON_USE_REMOTE_CHECKSUMS = $null
      NPM_CONFIG_ELECTRON_USE_REMOTE_CHECKSUMS = $null
      ELECTRON_OVERRIDE_DIST_PATH = $null
      ELECTRON_CUSTOM_DIR = $null
      ELECTRON_CUSTOM_FILENAME = $null
    }
    $originalEnvironment = @{}
    foreach ($entry in $environmentOverrides.GetEnumerator()) {
      $originalEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable(
        $entry.Key,
        [EnvironmentVariableTarget]::Process
      )
      [Environment]::SetEnvironmentVariable(
        $entry.Key,
        $entry.Value,
        [EnvironmentVariableTarget]::Process
      )
    }

    Push-Location $buildDirectory
    try {
      Invoke-CheckedCommand `
        -FilePath $runtime.Npm `
        -Arguments @("ci", "--no-audit", "--no-fund") `
        -Description "npm ci"

      Assert-ReviewedElectronDistribution `
        -SourceDirectory $buildDirectory `
        -Architecture $architecture

      Write-Step "Downloading the checksummed Electron runtime from GitHub."
      Invoke-CheckedCommand `
        -FilePath $runtime.Node `
        -Arguments @("node_modules\electron\install.js") `
        -Description "Electron runtime download"

      Write-Step "Validating dependency licenses and notices."
      Invoke-CheckedCommand `
        -FilePath $runtime.Npm `
        -Arguments @("run", "compliance:licenses") `
        -Description "license validation"

      Write-Step "Building Skill Recorder locally."
      Invoke-CheckedCommand `
        -FilePath $runtime.Npm `
        -Arguments @("run", "build") `
        -Description "local source build"
    } finally {
      foreach ($entry in $originalEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable(
          $entry.Key,
          $entry.Value,
          [EnvironmentVariableTarget]::Process
        )
      }
      Pop-Location
    }

    Assert-RequiredPaths -Root $buildDirectory -RelativePaths @(
      ".compliance\COMPLIANCE-README.md",
      ".compliance\THIRD-PARTY-LICENSES.txt",
      ".compliance\onnxruntime",
      "node_modules\@github\copilot\LICENSE.md",
      "node_modules\$platformPackage\LICENSE.md",
      "node_modules\electron\dist\LICENSE",
      "node_modules\electron\dist\LICENSES.chromium.html",
      "dist",
      "dist-electron"
    )

    $buildElectron = Get-ElectronExecutable -SourceDirectory $buildDirectory
    $buildCopilot = Join-Path $buildDirectory "node_modules\$platformPackage\copilot.exe"
    Assert-TrustedSignature `
      -Path $buildCopilot `
      -PublisherPattern "GitHub, Inc\." `
      -PublisherName "GitHub"

    $metadata = [ordered]@{
      schemaVersion = 1
      distributionMode = "source-local-build"
      commit = $Commit
      sourceUrl = "https://github.com/microsoft/skill-recorder/tree/$Commit"
      sourceArchiveSha256 = $sourceArchiveHash
      packageLockSha256 = (Get-FileHash -LiteralPath (Join-Path $buildDirectory "package-lock.json") -Algorithm SHA256).Hash.ToLowerInvariant()
      electronExecutableSha256 = (Get-FileHash -LiteralPath $buildElectron -Algorithm SHA256).Hash.ToLowerInvariant()
      nodeVersion = $runtime.Version
      nodeRuntime = $runtime.Root
      installedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $metadata | ConvertTo-Json -Depth 4 |
      Set-Content -LiteralPath (Join-Path $buildDirectory ".skill-recorder-install.json") -Encoding UTF8

    if (Test-Path -LiteralPath $sourceDirectory) {
      throw "Refusing to overwrite an existing source installation: $sourceDirectory"
    }
    Move-Item -LiteralPath $buildDirectory -Destination $sourceDirectory
    Remove-CachedDownload -CachePath $sourceArchive
  } finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
      Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
  }
}

Assert-RequiredPaths -Root $sourceDirectory -RelativePaths @(
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  ".compliance\COMPLIANCE-README.md",
  ".compliance\THIRD-PARTY-LICENSES.txt",
  "node_modules\@github\copilot\LICENSE.md",
  "node_modules\$platformPackage\LICENSE.md",
  "node_modules\electron\dist\LICENSE",
  "node_modules\electron\dist\LICENSES.chromium.html",
  "dist",
  "dist-electron"
)

$electronExecutable = Get-ElectronExecutable -SourceDirectory $sourceDirectory
$copilotExecutable = Join-Path $sourceDirectory "node_modules\$platformPackage\copilot.exe"
$electronHash = (Get-FileHash -LiteralPath $electronExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($electronHash -ne [string]$metadata.electronExecutableSha256) {
  throw "The installed Electron executable has changed since its checksum-verified download."
}
Assert-TrustedSignature `
  -Path $copilotExecutable `
  -PublisherPattern "GitHub, Inc\." `
  -PublisherName "GitHub"

$startMenuShortcut = $null
$desktopShortcut = $null

try {
  $startMenuShortcut = New-SourceShortcut `
    -Folder (Get-ShortcutFolder -SpecialFolder "Programs" -Description "Start Menu Programs") `
    -SourceDirectory $sourceDirectory `
    -ElectronExecutable $electronExecutable
} catch {
  Write-Warning "Could not create the Start Menu shortcut: $($_.Exception.Message)"
}

if ($createDesktopShortcut) {
  try {
    $desktopShortcut = New-SourceShortcut `
      -Folder (Get-ShortcutFolder -SpecialFolder "DesktopDirectory" -Description "Desktop") `
      -SourceDirectory $sourceDirectory `
      -ElectronExecutable $electronExecutable
  } catch {
    Write-Warning "Could not create the desktop shortcut: $($_.Exception.Message)"
  }
}

Write-Step "Installed commit $Commit at $sourceDirectory"
Write-Step "License materials remain in the source tree, dependency packages, and .compliance directory."
Write-Warning "This locally generated build is for local execution only. Do not redistribute it."

Write-Host ""
Write-Host "Skill Recorder is ready. Open it any time from these shortcuts:"
if ($null -ne $startMenuShortcut) {
  Write-Host "  Start Menu : $startMenuShortcut"
} else {
  Write-Host "  Start Menu : not created (see the warning above)"
}
if (-not $createDesktopShortcut) {
  Write-Host "  Desktop    : skipped because SKILL_RECORDER_NO_DESKTOP_SHORTCUT=1"
} elseif ($null -ne $desktopShortcut) {
  Write-Host "  Desktop    : $desktopShortcut"
} else {
  Write-Host "  Desktop    : not created (see the warning above)"
}
Write-Host "Each entry is named 'Skill Recorder (Source)' and starts this installed revision."
Write-Host ""

if (-not $skipLaunch) {
  Write-Step "Launching Skill Recorder."
  Start-Process `
    -FilePath $electronExecutable `
    -ArgumentList ('"{0}"' -f $sourceDirectory) `
    -WorkingDirectory $sourceDirectory | Out-Null
}
}
