import type { CopilotSignInResult } from "../common/ipc";

export type SignInAccount = "microsoft" | "personal" | "canceled";

export interface SignInOperations {
  hasMicrosoftHint(): Promise<boolean>;
  chooseAccount(signal: AbortSignal): Promise<SignInAccount>;
  prepareEnterprise(signal: AbortSignal): Promise<boolean>;
  login(signal: AbortSignal): Promise<void>;
  verifyAuthentication(signal: AbortSignal): Promise<boolean>;
  manualCommand?: string;
}

/** Only these deliberately authored messages may cross the IPC boundary. */
export class SignInError extends Error {}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class SignInCoordinator {
  private active: { id: string; owner: number; controller: AbortController } | undefined;

  constructor(private readonly timeoutMs = 5 * 60_000) {}

  cancel(id: string, owner: number): void {
    if (this.active?.id === id && this.active.owner === owner) {
      this.active.controller.abort();
    }
  }

  dispose(): void {
    this.active?.controller.abort();
  }

  async signIn(id: string, owner: number, operations: SignInOperations): Promise<CopilotSignInResult> {
    if (this.active) {
      return { ok: false, status: "failed", error: "Another sign-in is already in progress." };
    }
    const controller = new AbortController();
    const { signal } = controller;
    this.active = { id, owner, controller };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const hinted = await abortable(operations.hasMicrosoftHint(), signal);
      signal.throwIfAborted();
      if (hinted) {
        const account = await abortable(operations.chooseAccount(signal), signal);
        signal.throwIfAborted();
        if (account === "canceled") return { ok: false, status: "canceled" };
        if (account === "microsoft") {
          const ready = await abortable(operations.prepareEnterprise(signal), signal);
          signal.throwIfAborted();
          if (!ready) return { ok: false, status: "canceled" };
        }
      }
      // Login/verification own their subprocess cleanup; await it before releasing the lock.
      await operations.login(signal);
      signal.throwIfAborted();
      const authenticated = await operations.verifyAuthentication(signal);
      signal.throwIfAborted();
      if (!authenticated) {
        throw new SignInError("Login finished, but Copilot is still signed out. Try signing in again.");
      }
      return { ok: true, status: "authenticated" };
    } catch (error) {
      if (signal.aborted) {
        return timedOut
          ? {
              ok: false,
              status: "timed-out",
              error: "Sign-in timed out. Try again, or run the command below in a terminal.",
              command: operations.manualCommand,
            }
          : { ok: false, status: "canceled" };
      }
      return {
        ok: false,
        status: "failed",
        error: error instanceof SignInError ? error.message : "Could not complete sign-in. Please try again.",
        command: operations.manualCommand,
      };
    } finally {
      clearTimeout(timeout);
      this.active = undefined;
    }
  }
}
