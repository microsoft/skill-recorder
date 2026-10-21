import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { SignInError } from "./copilot-signin-flow";

export function copilotSignInCommand(cliPath: string, platform = process.platform): string {
  const quoted = platform === "win32"
    ? `& '${cliPath.replace(/'/g, "''")}'`
    : `'${cliPath.replace(/'/g, `'\\''`)}'`;
  return `${quoted} --no-auto-update login --web-flow`;
}

/**
 * Own the actual CLI process, not a detached terminal launcher. Browser OAuth works
 * without a console; shell interpolation and a lingering cmd /k are unnecessary.
 */
export function runCopilotLogin(
  cliPath: string,
  signal: AbortSignal,
  spawnProcess: (file: string, args: string[], options: SpawnOptions) => ChildProcess = spawn,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    // Use the reviewed bundled version, not a newer CLI from the user's update cache.
    const child = spawnProcess(cliPath, ["--no-auto-update", "login", "--web-flow"], {
      windowsHide: true,
      // No stdin means no automatic consent to plaintext credential storage.
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    let storageFailed = false;
    let unsupportedWebFlow = false;
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      // Recognize only authored diagnostics, including split chunks; never expose output.
      output += chunk;
      storageFailed ||= output.includes("Login succeeded, but the token was not saved.");
      unsupportedWebFlow ||= output.includes("unknown option '--web-flow'");
      output = output.slice(-4096);
    });
    const abort = () => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    let launchFailed = false;
    child.once("error", () => {
      launchFailed = true;
      // Spawn failures also emit close; wait for it before releasing the sign-in lock.
    });
    child.once("close", (code) => {
      output = "";
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (launchFailed) reject(new SignInError("Could not start the bundled Copilot CLI. Reinstall the app or use the command below."));
      else if (code === 0) resolve();
      else if (unsupportedWebFlow) reject(new SignInError("The bundled Copilot CLI does not support browser authorization. Update or reinstall Skill Recorder."));
      else if (storageFailed) reject(new SignInError("GitHub authorization completed, but the CLI could not save your credentials securely. Run the command below in a terminal to review its storage options."));
      else reject(new SignInError("Copilot login did not complete. Try again, or run the command below in a terminal to see the CLI's instructions."));
    });
    if (signal.aborted) abort();
  });
}
