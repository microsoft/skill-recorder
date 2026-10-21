import type { CopilotSignInResult } from "../common/ipc";

export async function completeSignIn(
  result: Promise<CopilotSignInResult>,
  isCurrent: () => boolean,
  onAuthenticated?: () => void | Promise<void>,
): Promise<CopilotSignInResult | null> {
  const settled = await result;
  if (!isCurrent()) return null;
  if (settled.ok && settled.status === "authenticated") await onAuthenticated?.();
  return isCurrent() ? settled : null;
}

export interface AnalysisRun {
  readonly retried: boolean;
  canceled: boolean;
}

/** Synchronous identity guards: React state alone cannot exclude same-tick clicks. */
export class AnalysisRecovery {
  private current: AnalysisRun | null = null;
  private eligible: AnalysisRun | null = null;
  private signingIn: AnalysisRun | null = null;

  beginRun(): AnalysisRun | null {
    if (this.current || this.signingIn) return null;
    this.eligible = null;
    return (this.current = { retried: false, canceled: false });
  }

  isCurrent(run: AnalysisRun): boolean {
    return this.current === run;
  }

  accepts(run: AnalysisRun): boolean {
    return this.isCurrent(run) && !run.canceled;
  }

  finishRun(run: AnalysisRun, signedOut: boolean): void {
    if (!this.isCurrent(run)) return;
    this.current = null;
    this.eligible = signedOut && !run.retried && !run.canceled ? run : null;
  }

  beginSignIn(run: AnalysisRun): boolean {
    if (this.current || this.signingIn || this.eligible !== run) return false;
    this.signingIn = run;
    return true;
  }

  retry(run: AnalysisRun): AnalysisRun | null {
    if (this.current || this.signingIn !== run || this.eligible !== run) return null;
    this.signingIn = null;
    this.eligible = null;
    return (this.current = { retried: true, canceled: false });
  }

  endSignIn(run: AnalysisRun, invalidate = true): void {
    if (this.signingIn !== run) return;
    this.signingIn = null;
    if (invalidate) this.eligible = null;
  }

  cancelRun(): void {
    if (this.current) this.current.canceled = true;
    this.eligible = null;
    this.signingIn = null;
  }

  invalidate(): void {
    this.cancelRun();
    this.current = null;
  }
}
