import { abortable, SignInError } from "./copilot-signin-flow";

interface AuthClient {
  start(): Promise<void>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  forceStop(): Promise<void>;
}

export async function verifyCopilotAuthentication(
  createClient: () => AuthClient,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<boolean> {
  signal.throwIfAborted();
  const client = createClient();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    await abortable(client.start(), bounded);
    bounded.throwIfAborted();
    return (await abortable(client.getAuthStatus(), bounded)).isAuthenticated;
  } catch {
    throw new SignInError("Could not verify Copilot authentication. Check your connection and try again.");
  } finally {
    await client.forceStop();
  }
}
