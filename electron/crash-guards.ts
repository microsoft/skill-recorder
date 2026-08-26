import { createLogger } from "./logger";

type Logger = ReturnType<typeof createLogger>;

/**
 * Last-resort process-level guards for the main process.
 *
 * The primary defense against a lost stream 'error' listener is to attach one at
 * each write stream (see SessionStore / VideoRecorder). This is the safety net for
 * anything that still slips through: a stray asynchronous failure is logged and
 * contained instead of taking down the whole main process — and with it any
 * recording in progress. It intentionally does NOT force-exit.
 *
 * Returns a disposer that removes the handlers (used by tests).
 */
export function installCrashGuards(log: Logger): () => void {
  const onUncaughtException = (err: unknown) => {
    log.error(
      "uncaught exception (contained):",
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  };
  const onUnhandledRejection = (reason: unknown) => {
    log.error(
      "unhandled rejection (contained):",
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    );
  };

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  return () => {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  };
}
