import { execFile } from "node:child_process";
import { createMicrosoftSignInHintProbe } from "../common/microsoft-signin-hint";
import { createLogger } from "./logger";

export { createMicrosoftSignInHintProbe, parseMicrosoftSignInHint } from "../common/microsoft-signin-hint";
export type { MicrosoftSignInHintDependencies } from "../common/microsoft-signin-hint";

export async function hasMicrosoftSignInHint(): Promise<boolean> {
  return createMicrosoftSignInHintProbe({
    platform: process.platform,
    systemRoot: process.env.SystemRoot ?? process.env.windir,
    execFile: (file, args, options, callback) => {
      execFile(file, args, options, callback);
    },
    log: createLogger("microsoft-signin-hint"),
  })();
}
