# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Skill Recorder contributors

param(
  [string]$InstallerPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "install.ps1")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1

$tokens = $null
$parseErrors = $null
$installerAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $InstallerPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
  $parseErrors | ForEach-Object { Write-Error $_.Message }
  throw "install.ps1 contains PowerShell syntax errors"
}

$helperNames = @(
  "Write-Step",
  "Write-InstallCompletion",
  "ConvertTo-ExtendedLengthPath",
  "Move-DirectoryTree",
  "Remove-DirectoryTree",
  "Resolve-MachineNpmConfigPath",
  "Get-SystemNpmGlobalConfigPath",
  "Get-DefaultWindowsNpmConfigPaths",
  "Get-MachineNpmConfigPath"
)
$functionDefinitions = @(
  $installerAst.FindAll(
    {
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
    },
    $true
  )
)
$helperSource = @(
  foreach ($helperName in $helperNames) {
    $matches = @($functionDefinitions | Where-Object Name -eq $helperName)
    if ($matches.Count -ne 1) {
      throw "Expected one $helperName definition in install.ps1, found $($matches.Count)."
    }
    $matches[0].Extent.Text
  }
)
. ([scriptblock]::Create($helperSource -join [Environment]::NewLine))

& {
  $messages = New-Object 'System.Collections.Generic.List[string]'
  function Write-Host {
    param([object]$Object)
    $messages.Add([string]$Object)
  }
  function Start-Process { throw "Installation must not launch Skill Recorder." }

  $source = 'C:\Users\O''Brien\$literal\Skill Recorder'
  $executable = Join-Path $source "node_modules\electron\dist\electron.exe"
  foreach ($shortcuts in @(
    @{ Start = "start.lnk"; Desktop = "desktop.lnk"; Requested = $true; Location = "desktop or Start menu" },
    @{ Start = "start.lnk"; Desktop = $null; Requested = $false; Location = "Start menu" },
    @{ Start = $null; Desktop = "desktop.lnk"; Requested = $true; Location = "desktop" },
    @{ Start = $null; Desktop = $null; Requested = $true; Location = "manual launch command" }
  )) {
    $messages.Clear()
    Write-InstallCompletion `
      -StartMenuShortcut $shortcuts.Start `
      -DesktopShortcut $shortcuts.Desktop `
      -DesktopShortcutRequested $shortcuts.Requested `
      -ElectronExecutable $executable `
      -SourceDirectory $source
    $rectangle = @($messages | Where-Object { $_ -like "@*" })
    if (
      @($rectangle | Where-Object { $_ -match "^@+$" }).Count -ne 4 -or
      @($rectangle | Where-Object { $_.Length -ne $rectangle[0].Length }).Count
    ) {
      throw "The completion notice must have aligned sides and double top/bottom borders."
    }
    $instruction = @($messages | Where-Object { $_ -match "^@ 3\." })
    if ($instruction.Count -ne 1 -or $instruction[0] -notlike "*$($shortcuts.Location)*") {
      throw "Completion did not direct the user to an available launch method."
    }

    $commands = @($messages | Where-Object { $_ -like "Start-Process *" })
    if ($shortcuts.Start -or $shortcuts.Desktop) {
      if ($commands.Count -ne 0) { throw "A working shortcut does not need a fallback command." }
    } else {
      if ($commands.Count -ne 1) { throw "Missing the manual launch fallback." }
      & {
        function Start-Process {
          param([string]$FilePath, [string]$ArgumentList, [string]$WorkingDirectory)
          if (
            $FilePath -cne $executable -or
            $ArgumentList -cne ('"' + $source + '"') -or
            $WorkingDirectory -cne $source
          ) {
            throw "The manual command did not preserve paths containing spaces, quotes, and dollar signs."
          }
        }
        & ([scriptblock]::Create($commands[0]))
      }
    }
  }
}

# Exercise the installer's reuse path without downloads, native signatures, or
# real shortcuts. Keep the actual top-level flow and completion code.
$installerBody = $installerAst.Extent.Text
foreach ($definition in ($functionDefinitions | Sort-Object { $_.Extent.StartOffset } -Descending)) {
  $installerBody = $installerBody.Remove(
    $definition.Extent.StartOffset,
    $definition.Extent.EndOffset - $definition.Extent.StartOffset
  )
}
& {
  $fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("skill-recorder-reuse-" + [guid]::NewGuid().ToString("N"))
  $fixtureCommit = "a" * 40
  $fixtureSource = Join-Path (Join-Path $fixtureRoot "versions") $fixtureCommit
  $fixtureElectron = Join-Path $fixtureSource "electron.exe"
  $messages = New-Object 'System.Collections.Generic.List[string]'
  $shortcutTargets = New-Object 'System.Collections.Generic.List[string]'
  $savedEnvironment = @{}
  foreach ($name in @(
    "SKILL_RECORDER_COMMIT", "SKILL_RECORDER_INSTALL_ROOT",
    "SKILL_RECORDER_NO_LAUNCH", "SKILL_RECORDER_NO_DESKTOP_SHORTCUT"
  )) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  function Write-Host {
    param([object]$Object)
    $messages.Add([string]$Object)
  }
  function Write-Warning { param([string]$Message) }
  function Get-WindowsArchitecture { return "x64" }
  function Get-ElectronExecutable { return $fixtureElectron }
  function Assert-RequiredPaths {}
  function Assert-TrustedSignature {}
  function Get-ShortcutFolder {
    param([string]$SpecialFolder, [string]$Description)
    return (Join-Path $fixtureRoot $SpecialFolder)
  }
  function New-SourceShortcut {
    param([string]$Folder, [string]$SourceDirectory, [string]$ElectronExecutable)
    $shortcutTargets.Add($SourceDirectory)
    return (Join-Path $Folder "Skill Recorder (Source).lnk")
  }
  function Start-Process { throw "Reusing an installation must not launch an application." }

  try {
    New-Item -ItemType Directory -Path $fixtureSource -Force | Out-Null
    $lockfile = Join-Path $fixtureSource "package-lock.json"
    Set-Content -LiteralPath $lockfile -Value "{}" -Encoding ASCII
    Set-Content -LiteralPath $fixtureElectron -Value "unexecuted test fixture" -Encoding ASCII
    @{
      commit = $fixtureCommit
      packageLockSha256 = (Get-FileHash -LiteralPath $lockfile).Hash.ToLowerInvariant()
      electronExecutableSha256 = (Get-FileHash -LiteralPath $fixtureElectron).Hash.ToLowerInvariant()
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureSource ".skill-recorder-install.json")
    $env:SKILL_RECORDER_COMMIT = $fixtureCommit
    $env:SKILL_RECORDER_INSTALL_ROOT = $fixtureRoot
    $env:SKILL_RECORDER_NO_DESKTOP_SHORTCUT = "0"
    foreach ($noLaunch in @($null, "1")) {
      [Environment]::SetEnvironmentVariable("SKILL_RECORDER_NO_LAUNCH", $noLaunch, "Process")
      $messages.Clear()
      $shortcutTargets.Clear()
      & ([scriptblock]::Create($installerBody))
      if ($shortcutTargets.Count -ne 2 -or @($shortcutTargets | Where-Object { $_ -ne $fixtureSource }).Count) {
        throw "Reusing an installation did not refresh both shortcuts to the selected revision."
      }
      if (-not ($messages -match "SKILL RECORDER INSTALLED") -or -not ($messages -match "Quit in ALL running copies")) {
        throw "Reusing an installation omitted the manual handover notice."
      }
    }
  } finally {
    foreach ($name in $savedEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
    Remove-DirectoryTree -Path $fixtureRoot
  }
}

$uncPath = ConvertTo-ExtendedLengthPath -Path "\\server\share\folder"
if ($uncPath -ne "\\?\UNC\server\share\folder") {
  throw "Extended-length UNC conversion returned an unexpected path: $uncPath"
}

$npmConfigRoot = Join-Path (
  [IO.Path]::GetTempPath()
) ("skill-recorder-npmrc-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $npmConfigRoot -Force | Out-Null
try {
  $machineNpmrc = Join-Path $npmConfigRoot "npmrc"
  Set-Content -LiteralPath $machineNpmrc -Value "registry=https://example.invalid/npm/" -Encoding ASCII
  $missingNpmrc = Join-Path $npmConfigRoot "missing\npmrc"

  $resolved = Resolve-MachineNpmConfigPath -CandidatePaths @($missingNpmrc, $machineNpmrc)
  if ($resolved -ne [IO.Path]::GetFullPath($machineNpmrc)) {
    throw "Resolve-MachineNpmConfigPath skipped the existing npmrc: $resolved"
  }

  # npm prints "undefined" when no global config is configured; it is not a path.
  $placeholders = Resolve-MachineNpmConfigPath -CandidatePaths @("undefined", "null", "", $null)
  if ($null -ne $placeholders) {
    throw "Resolve-MachineNpmConfigPath accepted a placeholder value: $placeholders"
  }

  # Installs on machines without any npm configuration must stay on the default registry.
  $absent = Resolve-MachineNpmConfigPath -CandidatePaths @($missingNpmrc)
  if ($null -ne $absent) {
    throw "Resolve-MachineNpmConfigPath returned a nonexistent npmrc: $absent"
  }

  $quoted = Resolve-MachineNpmConfigPath -CandidatePaths @(('"' + $machineNpmrc + '" '))
  if ($quoted -ne [IO.Path]::GetFullPath($machineNpmrc)) {
    throw "Resolve-MachineNpmConfigPath did not normalize a quoted npm path: $quoted"
  }

  # Isolate discovery from the test host's npm installation and configuration.
  & {
    $environmentNames = @(
      "APPDATA", "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)",
      "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_PREFIX", "NPM_CONFIG_USERCONFIG",
      "NPM_CONFIG_REGISTRY"
    )
    $savedEnvironment = @{}
    foreach ($name in $environmentNames) {
      $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    function Get-Command { return $null }
    try {
      $env:APPDATA = Join-Path $npmConfigRoot "appdata"
      $env:ProgramW6432 = Join-Path $npmConfigRoot "native-program-files"
      $env:ProgramFiles = Join-Path $npmConfigRoot "program-files"
      ${env:ProgramFiles(x86)} = Join-Path $npmConfigRoot "x86-program-files"

      if ($null -ne (Get-SystemNpmGlobalConfigPath)) {
        throw "Discovery unexpectedly found npm on the clean-machine fixture."
      }
      if ($null -ne (Get-MachineNpmConfigPath)) {
        throw "A clean noncorporate machine must retain npm's default registry."
      }

      $paths = @(Get-DefaultWindowsNpmConfigPaths)
      if ($paths.Count -ne 4) {
        throw "Expected the user, native, current, and x86 global config locations."
      }
      # Create the lowest-priority files first to exercise every fallback.
      for ($index = $paths.Count - 1; $index -ge 0; $index--) {
        $path = $paths[$index]
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        Set-Content -LiteralPath $path -Value "registry=https://example.invalid/npm/" -Encoding ASCII
        if ((Get-MachineNpmConfigPath) -ne $path) {
          throw "npm-free discovery did not select $path."
        }
      }

      $env:NPM_CONFIG_PREFIX = Join-Path $npmConfigRoot "explicit-prefix"
      if ($null -ne (Get-MachineNpmConfigPath)) {
        throw "A caller's empty prefix must not pick up another installation's settings."
      }
      $prefixConfig = Join-Path $env:NPM_CONFIG_PREFIX "etc\npmrc"
      New-Item -ItemType Directory -Path (Split-Path -Parent $prefixConfig) -Force | Out-Null
      Set-Content -LiteralPath $prefixConfig -Value "registry=https://example.invalid/custom/" -Encoding ASCII
      if ((Get-MachineNpmConfigPath) -ne $prefixConfig) {
        throw "The explicit npm prefix was not honored without npm."
      }
      $env:NPM_CONFIG_PREFIX = $null

      foreach ($explicitConfig in @($machineNpmrc, $missingNpmrc)) {
        $env:NPM_CONFIG_GLOBALCONFIG = $explicitConfig
        if ($null -ne (Get-MachineNpmConfigPath)) {
          throw "Discovery must leave explicit globalconfig to npm, even if missing."
        }
        if ($env:NPM_CONFIG_GLOBALCONFIG -ne $explicitConfig) {
          throw "Discovery modified the caller's globalconfig."
        }
      }
      $env:NPM_CONFIG_GLOBALCONFIG = $null

      function Get-SystemNpmGlobalConfigPath { return $machineNpmrc }
      if ((Get-MachineNpmConfigPath) -ne $machineNpmrc) {
        throw "The system npm's reported global configuration must take precedence."
      }

      if ($npmCommand) {
        $env:NPM_CONFIG_GLOBALCONFIG = Get-MachineNpmConfigPath
        $env:NPM_CONFIG_USERCONFIG = Join-Path $npmConfigRoot "user.npmrc"
        $originalHash = (Get-FileHash -LiteralPath $machineNpmrc).Hash
        Push-Location $npmConfigRoot
        try {
          function Assert-NpmRegistry {
            param([string]$Expected)
            $actual = @(& $npmCommand.Source config get registry 2>$null)
            if ($LASTEXITCODE -ne 0 -or $actual.Count -ne 1 -or $actual[0] -ne $Expected) {
              throw "npm did not honor the expected registry precedence."
            }
          }
          Assert-NpmRegistry "https://example.invalid/npm/"
          Set-Content -LiteralPath $env:NPM_CONFIG_USERCONFIG `
            -Value "registry=https://example.invalid/user/" -Encoding ASCII
          Assert-NpmRegistry "https://example.invalid/user/"
          $env:NPM_CONFIG_REGISTRY = "https://example.invalid/environment/"
          Assert-NpmRegistry "https://example.invalid/environment/"
          if ((Get-FileHash -LiteralPath $machineNpmrc).Hash -ne $originalHash) {
            throw "Reading npm settings modified the managed global configuration."
          }
        } finally {
          Pop-Location
        }
      } else {
        Write-Warning "npm is unavailable; skipping the real-npm precedence check (npm-free discovery was tested)."
      }
    } finally {
      foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
      }
    }
  }
} finally {
  Remove-Item -LiteralPath $npmConfigRoot -Recurse -Force
}

$testRoot = Join-Path (
  [IO.Path]::GetTempPath()
) ("skill-recorder-installer-" + [guid]::NewGuid().ToString("N"))
$sourceDirectory = Join-Path $testRoot ("source-" + ("a" * 96))
$nestedDirectoryName = "b" * 120
$sourceFile = Join-Path (
  Join-Path $sourceDirectory $nestedDirectoryName
) "coverage.json"
$destinationDirectory = Join-Path $testRoot "build"
$destinationFile = Join-Path (
  Join-Path $destinationDirectory $nestedDirectoryName
) "coverage.json"

try {
  [IO.Directory]::CreateDirectory(
    (ConvertTo-ExtendedLengthPath -Path (Split-Path -Parent $sourceFile))
  ) | Out-Null
  [IO.File]::WriteAllText(
    (ConvertTo-ExtendedLengthPath -Path $sourceFile),
    "installer long-path regression"
  )
  [IO.File]::SetAttributes(
    (ConvertTo-ExtendedLengthPath -Path $sourceFile),
    [IO.FileAttributes]::ReadOnly
  )

  if ($sourceFile.Length -le 260) {
    throw "Long-path test setup produced only $($sourceFile.Length) characters."
  }

  Move-DirectoryTree -Source $sourceDirectory -Destination $destinationDirectory
  if ([IO.Directory]::Exists((ConvertTo-ExtendedLengthPath -Path $sourceDirectory))) {
    throw "Move-DirectoryTree left the source directory behind."
  }
  if (-not [IO.File]::Exists((ConvertTo-ExtendedLengthPath -Path $destinationFile))) {
    throw "Move-DirectoryTree did not move the long-path test file."
  }

  Remove-DirectoryTree -Path $destinationDirectory
  if ([IO.Directory]::Exists((ConvertTo-ExtendedLengthPath -Path $destinationDirectory))) {
    throw "Remove-DirectoryTree left the destination directory behind."
  }
  $lockedSourceDirectory = Join-Path $testRoot "locked-source"
  $lockedDestinationDirectory = Join-Path $testRoot "locked-destination"
  $lockedFile = Join-Path $lockedSourceDirectory "scanned.exe"
  $readyFile = Join-Path $testRoot "locker-ready"
  [IO.Directory]::CreateDirectory($lockedSourceDirectory) | Out-Null
  [IO.File]::WriteAllText($lockedFile, "endpoint scanner simulation")

  $escapedLockedFile = $lockedFile.Replace("'", "''")
  $escapedReadyFile = $readyFile.Replace("'", "''")
  $lockerSource = @"
`$stream = [IO.File]::Open(
  '$escapedLockedFile',
  [IO.FileMode]::Open,
  [IO.FileAccess]::Read,
  [IO.FileShare]::Read
)
try {
  [IO.File]::WriteAllText('$escapedReadyFile', 'ready')
  # Avoid cold cmdlet discovery extending the lock beyond the retry window.
  [Threading.Thread]::Sleep(500)
} finally {
  `$stream.Dispose()
}
"@
  $encodedLockerSource = [Convert]::ToBase64String(
    [Text.Encoding]::Unicode.GetBytes($lockerSource)
  )
  $powerShellExecutable = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $locker = Start-Process `
    -FilePath $powerShellExecutable `
    -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", $encodedLockerSource) `
    -PassThru
  try {
    $readyDeadline = (Get-Date).AddSeconds(10)
    while (-not [IO.File]::Exists($readyFile)) {
      if ((Get-Date) -ge $readyDeadline -or $locker.HasExited) {
        throw "The directory-lock test helper did not become ready."
      }
      Start-Sleep -Milliseconds 25
    }

    Move-DirectoryTree `
      -Source $lockedSourceDirectory `
      -Destination $lockedDestinationDirectory `
      -MaxAttempts 6 `
      -RetryDelayMilliseconds 100
    if (-not [IO.Directory]::Exists($lockedDestinationDirectory)) {
      throw "Move-DirectoryTree did not recover from a transient file lock."
    }
  } finally {
    if (-not $locker.HasExited) {
      Stop-Process -Id $locker.Id -Force
      $locker.WaitForExit()
    }
    $locker.Dispose()
  }
} finally {
  Remove-DirectoryTree -Path $testRoot
}

Write-Host "Windows installer tests passed."
