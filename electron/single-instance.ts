interface InstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance" | "activate", listener: () => void): unknown;
}

interface Activation {
  isQuitting(): boolean;
  isRecording(): boolean;
  showRecorder(): void;
  showRecordingControls(): void;
}

/** Returns the primary instance's ready callback, or null for a duplicate. */
export function registerSingleInstance(
  app: InstanceApp,
  activation: Activation,
): (() => void) | null {
  if (!app.requestSingleInstanceLock()) return null;

  let ready = false;
  let pending = false;
  const reveal = () => {
    if (!ready) {
      pending = true;
      return;
    }
    if (activation.isQuitting()) return;
    if (activation.isRecording()) activation.showRecordingControls();
    else activation.showRecorder();
  };

  app.on("second-instance", reveal);
  app.on("activate", reveal);

  return () => {
    ready = true;
    if (pending) {
      pending = false;
      reveal();
    }
  };
}
