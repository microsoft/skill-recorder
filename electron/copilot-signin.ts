import { dialog, shell, type BrowserWindow, type MessageBoxOptions } from "electron";
import { CopilotClient } from "@github/copilot-sdk";

import type { CopilotSignInResult } from "../common/ipc";
import { copilotConnectionOption, resolveCopilotCliPath } from "./copilot-cli-path";
import { verifyCopilotAuthentication } from "./copilot-signin-auth";
import { SignInCoordinator, SignInError } from "./copilot-signin-flow";
import { copilotSignInCommand, runCopilotLogin } from "./copilot-signin-process";
import { createLogger } from "./logger";
import { hasMicrosoftSignInHint } from "./microsoft-signin-hint";

const log = createLogger("CopilotSignIn");
const coordinator = new SignInCoordinator();
const MICROSOFT_ENTERPRISE_URL = "https://github.com/enterprises/microsoft";

export function cancelCopilotSignIn(attemptId: string, owner: number): void {
  coordinator.cancel(attemptId, owner);
}

export function disposeCopilotSignIn(): void {
  coordinator.dispose();
}

export async function openCopilotSignIn(
  attemptId: string,
  owner: number,
  parent: BrowserWindow | null,
): Promise<CopilotSignInResult> {
  const cliPath = resolveCopilotCliPath();
  if (!cliPath) {
    return {
      ok: false,
      status: "failed",
      error: "Skill Recorder couldn't find its bundled GitHub Copilot CLI. Reinstall the app.",
    };
  }
  const show = (options: MessageBoxOptions) =>
    parent && !parent.isDestroyed()
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options);
  const result = await coordinator.signIn(attemptId, owner, {
    hasMicrosoftHint: hasMicrosoftSignInHint,
    chooseAccount: async (signal) => {
      const { response } = await show({
        type: "question",
        title: "Sign in to GitHub Copilot",
        message: "Use Microsoft Enterprise SSO or a personal GitHub account?",
        detail: "This Windows account or device appears to be associated with Microsoft. Microsoft sign-in has two steps: complete SSO in your browser, then authorize the GitHub Copilot app. When the Microsoft enterprise page appears, close that tab and return to Skill Recorder for step 2.",
        buttons: ["Microsoft Enterprise SSO", "Personal GitHub account", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        signal,
      });
      return response === 0 ? "microsoft" : response === 1 ? "personal" : "canceled";
    },
    prepareEnterprise: async (signal) => {
      signal.throwIfAborted();
      try {
        await shell.openExternal(MICROSOFT_ENTERPRISE_URL);
      } catch {
        throw new SignInError("Could not open the enterprise sign-in page. Check your default browser and try again.");
      }
      signal.throwIfAborted();
      const { response } = await show({
        type: "info",
        title: "Microsoft Enterprise SSO",
        message: "Step 1 of 2: Complete Microsoft SSO",
        detail: "When SSO finishes on github.com/enterprises/microsoft, close that tab and return here. SSO alone does not authorize Copilot.\n\nChoose \"Authorize Copilot\" to open step 2. Use the same browser profile and Microsoft-linked GitHub account, then approve the GitHub Copilot app. No device code is needed.\n\nAfter authorization, close that tab and return to Skill Recorder. If GitHub says to return to your terminal, return here instead.",
        buttons: ["Authorize Copilot", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        signal,
      });
      return response === 0;
    },
    login: (signal) => runCopilotLogin(cliPath, signal),
    verifyAuthentication: (signal) => verifyCopilotAuthentication(
      () => new CopilotClient(copilotConnectionOption()), signal,
    ),
    manualCommand: copilotSignInCommand(cliPath),
  });
  // Do not record CLI output, account names, tenant metadata, or browser URLs.
  if (result.ok) log.info("Copilot sign-in verified");
  else if (result.status !== "canceled") log.warn("Copilot sign-in ended:", result.status);
  return result;
}
