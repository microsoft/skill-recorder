import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type {
  TerminalIntegrationQuality,
  TerminalShellDescriptor,
} from "../../common/terminal";

export interface ShellIntegrationOptions {
  nonce: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  temporaryRoot?: string;
}

export interface IntegratedShellLaunch {
  executable: string;
  args: string[];
  env: Record<string, string>;
  integrationQuality: TerminalIntegrationQuality;
  integrationDirectory: string;
  cleanup: () => Promise<void>;
}

const OSC = "6973;skill-recorder;1";

function environment(input: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const POSIX_ENCODER = `
__sr_pct() {
  local LC_ALL=C __sr_input="$1" __sr_output="" __sr_char __sr_hex __sr_i
  __sr_i=0
  while [ "$__sr_i" -lt "\${#__sr_input}" ]; do
    __sr_char="\${__sr_input:$__sr_i:1}"
    case "$__sr_char" in
      [a-zA-Z0-9._~-]) __sr_output="\${__sr_output}\${__sr_char}" ;;
      *) printf -v __sr_hex '%02X' "'$__sr_char"; __sr_output="\${__sr_output}%\${__sr_hex}" ;;
    esac
    __sr_i=$((__sr_i + 1))
  done
  REPLY="$__sr_output"
}
`;

function zshScript(nonce: string, profile: string): string {
  return `# Skill Recorder generated shell integration. This file is session-local.
if [[ -r ${shQuote(profile)} ]]; then
  source ${shQuote(profile)}
fi
${POSIX_ENCODER}
zmodload zsh/datetime 2>/dev/null
typeset -g __sr_active_id=""
typeset -gi __sr_counter=0

__sr_now() {
  local __sr_raw="\${EPOCHREALTIME/./}"
  REPLY="\${__sr_raw[1,13]}"
}

__sr_emit_ready() {
  printf '\\033]${OSC};${nonce};ready\\007'
}

__sr_preexec() {
  local __sr_command="$1" __sr_cwd="$PWD" __sr_command_enc __sr_cwd_enc __sr_id_enc
  __sr_counter=$((__sr_counter + 1))
  __sr_active_id="$$-$__sr_counter"
  __sr_pct "$__sr_active_id"; __sr_id_enc="$REPLY"
  __sr_pct "$__sr_command"; __sr_command_enc="$REPLY"
  __sr_pct "$__sr_cwd"; __sr_cwd_enc="$REPLY"
  __sr_now
  printf '\\033]${OSC};${nonce};start;%s;%s;%s;zsh;%s\\007' "$__sr_id_enc" "$__sr_command_enc" "$__sr_cwd_enc" "$REPLY"
}

__sr_precmd() {
  local __sr_status="$?" __sr_id_enc
  if [[ -n "$__sr_active_id" ]]; then
    __sr_pct "$__sr_active_id"; __sr_id_enc="$REPLY"
    __sr_now
    printf '\\033]${OSC};${nonce};finish;%s;%s;%s\\007' "$__sr_id_enc" "$__sr_status" "$REPLY"
    __sr_active_id=""
  fi
  __sr_emit_ready
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __sr_preexec
add-zsh-hook precmd __sr_precmd
`;
}

function bashScript(nonce: string, profile: string): string {
  return `# Skill Recorder generated shell integration. This file is session-local.
if [ -r ${shQuote(profile)} ]; then
  . ${shQuote(profile)}
fi
${POSIX_ENCODER}
__sr_active_id=""
__sr_counter=0
__sr_guard=0
__sr_user_prompt_commands=()
__sr_prompt_command_decl="$(declare -p PROMPT_COMMAND 2>/dev/null || :)"
if [[ "$__sr_prompt_command_decl" == "declare -a"* ]]; then
  __sr_user_prompt_commands=("\${PROMPT_COMMAND[@]}")
elif [ -n "\${PROMPT_COMMAND-}" ]; then
  __sr_user_prompt_commands=("\${PROMPT_COMMAND}")
fi
__sr_user_histcontrol="\${HISTCONTROL-}"
__sr_user_histignore="\${HISTIGNORE-}"
HISTFILE=/dev/null

__sr_arm_history() {
  __sr_user_histcontrol="\${HISTCONTROL-}"
  __sr_user_histignore="\${HISTIGNORE-}"
  HISTCONTROL=
  HISTIGNORE=
}

__sr_now() {
  REPLY="$(date +%s)000"
}

__sr_emit_ready() {
  printf '\\033]${OSC};${nonce};ready\\007'
}

__sr_debug() {
  local __sr_trigger="$BASH_COMMAND" __sr_command __sr_cwd __sr_command_enc __sr_cwd_enc __sr_id_enc
  [ "$__sr_guard" -ne 0 ] && return
  [ -n "$__sr_active_id" ] && return
  case "$__sr_trigger" in __sr_*|trap\\ *|PROMPT_COMMAND=*) return ;; esac
  __sr_guard=1
  HISTCONTROL="$__sr_user_histcontrol"
  HISTIGNORE="$__sr_user_histignore"
  __sr_command="$(HISTTIMEFORMAT= builtin history 1)"
  __sr_command="\${__sr_command#"\${__sr_command%%[![:space:]]*}"}"
  __sr_command="\${__sr_command#* }"
  __sr_command="\${__sr_command#"\${__sr_command%%[![:space:]]*}"}"
  if [ -z "$__sr_command" ]; then
    __sr_guard=0
    return
  fi
  __sr_counter=$((__sr_counter + 1))
  __sr_active_id="$$-$__sr_counter"
  __sr_cwd="$PWD"
  __sr_pct "$__sr_active_id"; __sr_id_enc="$REPLY"
  __sr_pct "$__sr_command"; __sr_command_enc="$REPLY"
  __sr_pct "$__sr_cwd"; __sr_cwd_enc="$REPLY"
  __sr_now
  printf '\\033]${OSC};${nonce};start;%s;%s;%s;bash;%s\\007' "$__sr_id_enc" "$__sr_command_enc" "$__sr_cwd_enc" "$REPLY"
  __sr_guard=0
}

__sr_prompt() {
  local __sr_status="$?" __sr_id_enc __sr_prompt_hook
  __sr_guard=1
  HISTCONTROL="$__sr_user_histcontrol"
  HISTIGNORE="$__sr_user_histignore"
  if [ -n "$__sr_active_id" ]; then
    __sr_pct "$__sr_active_id"; __sr_id_enc="$REPLY"
    __sr_now
    printf '\\033]${OSC};${nonce};finish;%s;%s;%s\\007' "$__sr_id_enc" "$__sr_status" "$REPLY"
    __sr_active_id=""
  fi
  __sr_emit_ready
  for __sr_prompt_hook in "\${__sr_user_prompt_commands[@]}"; do
    [ -n "$__sr_prompt_hook" ] && eval "$__sr_prompt_hook"
  done
  __sr_arm_history
  __sr_guard=0
  return "$__sr_status"
}

__sr_guard=1
__sr_arm_history
trap '__sr_debug' DEBUG
PROMPT_COMMAND='__sr_prompt'
__sr_guard=0
`;
}

function fishScript(nonce: string, profile: string): string {
  return `# Skill Recorder generated shell integration. This file is session-local.
if test -r ${shQuote(profile)}
  source ${shQuote(profile)}
end

set -g __sr_active_id ""
set -g __sr_counter 0

function __sr_pct
  string escape --style=url -- "$argv[1]"
end

function __sr_now
  printf '%s000' (date +%s)
end

function __sr_prompt_ready --on-event fish_prompt
  printf '\\e]${OSC};${nonce};ready\\a'
end

function __sr_preexec --on-event fish_preexec
  set -g __sr_counter (math $__sr_counter + 1)
  set -g __sr_active_id "$fish_pid-$__sr_counter"
  printf '\\e]${OSC};${nonce};start;%s;%s;%s;fish;%s\\a' (__sr_pct "$__sr_active_id") (__sr_pct "$argv[1]") (__sr_pct "$PWD") (__sr_now)
end

function __sr_postexec --on-event fish_postexec
  set -l __sr_status $status
  if test -n "$__sr_active_id"
    printf '\\e]${OSC};${nonce};finish;%s;%s;%s\\a' (__sr_pct "$__sr_active_id") "$__sr_status" (__sr_now)
    set -g __sr_active_id ""
  end
end
`;
}

function powershellScript(
  nonce: string,
  shell: "pwsh" | "windows-powershell",
): string {
  return `# Skill Recorder generated shell integration. This file is session-local.
$__srProfile = $PROFILE
if (Test-Path -LiteralPath $__srProfile) { . $__srProfile }

$script:__srNonce = ${psQuote(nonce)}
$script:__srShell = ${psQuote(shell)}
$script:__srCounter = 0
$script:__srActiveId = $null
$script:__srActiveIsNative = $false
$script:__srLastHistoryId = -1
$__srPromptCommand = Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue
$__srReadLineCommand = Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue
$script:__srPriorPrompt = if ($null -ne $__srPromptCommand) { $__srPromptCommand.ScriptBlock } else { $null }
$script:__srPriorReadLine = if ($null -ne $__srReadLineCommand) { $__srReadLineCommand.ScriptBlock } else { $null }

function script:__srPct([string] $Value) {
  $builder = [System.Text.StringBuilder]::new()
  foreach ($byte in [System.Text.Encoding]::UTF8.GetBytes($Value)) {
    if (($byte -ge 0x41 -and $byte -le 0x5A) -or
        ($byte -ge 0x61 -and $byte -le 0x7A) -or
        ($byte -ge 0x30 -and $byte -le 0x39) -or
        $byte -in 0x2D, 0x2E, 0x5F, 0x7E) {
      [void] $builder.Append([char] $byte)
    } else {
      [void] $builder.Append(('%{0:X2}' -f $byte))
    }
  }
  $builder.ToString()
}

function script:__srNow { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function script:__srStart([string] $Command, [long] $At = 0) {
  $script:__srCounter++
  $script:__srActiveId = "$PID-$script:__srCounter"
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($Command, [ref] $tokens, [ref] $parseErrors)
  $commandAsts = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
  }, $true))
  $script:__srActiveIsNative = $false
  if ($commandAsts.Count -gt 0) {
    $commandName = $commandAsts[-1].GetCommandName()
    if ($null -ne $commandName) {
      $resolved = Get-Command $commandName -ErrorAction SilentlyContinue |
        Select-Object -First 1
      $script:__srActiveIsNative =
        $null -ne $resolved -and
        $resolved.CommandType -in @(
          [System.Management.Automation.CommandTypes]::Application,
          [System.Management.Automation.CommandTypes]::ExternalScript
        )
    }
  }
  if ($At -le 0) { $At = __srNow }
  $marker = "$([char]27)]${OSC};$script:__srNonce;start;$(__srPct $script:__srActiveId);$(__srPct $Command);$(__srPct (Get-Location).Path);$script:__srShell;$At$([char]7)"
  [Console]::Write($marker)
}

function script:__srFinish([int] $Code) {
  if ($null -ne $script:__srActiveId) {
    $marker = "$([char]27)]${OSC};$script:__srNonce;finish;$(__srPct $script:__srActiveId);$Code;$(__srNow)$([char]7)"
    [Console]::Write($marker)
    $script:__srActiveId = $null
    $script:__srActiveIsNative = $false
  }
}

function script:__srExitCode([bool] $Succeeded) {
  if ($Succeeded) { return 0 }
  if ($script:__srActiveIsNative -and $null -ne $global:LASTEXITCODE) {
    return [int] $global:LASTEXITCODE
  }
  return 1
}

function global:PSConsoleHostReadLine {
  if ($null -ne $script:__srPriorReadLine) {
    $line = & $script:__srPriorReadLine
  } else {
    $line = [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext)
  }
  __srStart $line
  return $line
}

function global:prompt {
  $succeeded = $?
  $exitCode = __srExitCode $succeeded
  $latest = Get-History -Count 1 -ErrorAction SilentlyContinue
  if ($null -ne $script:__srActiveId) {
    __srFinish $exitCode
    if ($null -ne $latest) { $script:__srLastHistoryId = $latest.Id }
  } elseif ($null -ne $latest -and $latest.Id -ne $script:__srLastHistoryId) {
    $script:__srLastHistoryId = $latest.Id
    __srStart $latest.CommandLine ([DateTimeOffset]$latest.StartExecutionTime).ToUnixTimeMilliseconds()
    __srFinish $(__srExitCode $succeeded)
  }
  [Console]::Write("$([char]27)]${OSC};$script:__srNonce;ready$([char]7)")
  if ($null -ne $script:__srPriorPrompt) {
    return & $script:__srPriorPrompt
  }
  return "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}
`;
}

/**
 * Builds a session-local shell startup file. The user's profile is sourced from
 * the wrapper, but is never written or replaced.
 */
export async function prepareShellIntegration(
  shell: TerminalShellDescriptor,
  options: ShellIntegrationOptions,
): Promise<IntegratedShellLaunch> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.nonce)) {
    throw new Error("Terminal integration nonce must be 16-128 URL-safe characters");
  }
  const baseEnv = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const root = options.temporaryRoot ?? tmpdir();
  const directory = await mkdtemp(path.join(root, "skill-recorder-terminal-"));
  const env = environment(baseEnv);
  let scriptPath: string;
  let script: string;
  let args: string[];

  switch (shell.id) {
    case "zsh": {
      scriptPath = path.join(directory, ".zshrc");
      const originalZdotdir = baseEnv.ZDOTDIR || home;
      script = zshScript(options.nonce, path.join(originalZdotdir, ".zshrc"));
      args = ["-i"];
      env.ZDOTDIR = directory;
      break;
    }
    case "bash":
      scriptPath = path.join(directory, "bashrc");
      script = bashScript(options.nonce, path.join(home, ".bashrc"));
      args = ["--rcfile", scriptPath, "-i"];
      break;
    case "fish": {
      const fishDirectory = path.join(directory, "fish");
      await writeFile(path.join(directory, ".keep"), "", { mode: 0o600 });
      const originalConfig = baseEnv.XDG_CONFIG_HOME
        ? path.join(baseEnv.XDG_CONFIG_HOME, "fish", "config.fish")
        : path.join(home, ".config", "fish", "config.fish");
      await mkdir(fishDirectory, { recursive: true });
      scriptPath = path.join(fishDirectory, "config.fish");
      script = fishScript(options.nonce, originalConfig);
      args = ["-i"];
      env.XDG_CONFIG_HOME = directory;
      break;
    }
    case "pwsh":
    case "windows-powershell":
      scriptPath = path.join(directory, "profile.ps1");
      script = powershellScript(options.nonce, shell.id);
      args = [
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ];
      break;
  }

  try {
    await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    executable: shell.executable,
    args,
    env,
    integrationQuality: "full",
    integrationDirectory: directory,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
