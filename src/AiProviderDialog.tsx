import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  MEMORY_KEY_NOTICE, PROVIDERS, aiConnectionReady, aiDestination, parseByomConfig, sameCredentialDestination,
  type AiConnectionResult, type AiConnectionStatus, type ByomConfig,
} from "../common/ai-provider";

interface ConnectionContext {
  status: AiConnectionStatus | null;
  notice: string | null;
  request(owner: string): Promise<boolean>;
  cancel(owner: string): void;
}

const Context = createContext<ConnectionContext | null>(null);

export function AiConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AiConnectionStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AiConnectionStatus | null>(null);
  const pending = useRef<{ owner: string; resolve: (value: boolean) => void } | null>(null);

  const finish = useCallback((success: boolean) => {
    const request = pending.current;
    pending.current = null;
    setDialog(null);
    request?.resolve(success);
  }, []);

  useEffect(() => {
    let live = true;
    void window.skillRecorder.aiConnectionStatus().then((next) => {
      if (live) setStatus(next);
    }).catch(() => { if (live) setNotice("Could not read the AI connection. Try opening AI connection again."); });
    const off = window.skillRecorder.onAiConnectionChanged((next) => {
      if (live) { setStatus(next); setNotice(next.warning ?? null); }
    });
    return () => { live = false; off(); finish(false); };
  }, [finish]);

  const request = useCallback((owner: string): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      const current = { owner, resolve };
      pending.current = current;
      void window.skillRecorder.aiConnectionStatus().then((next) => {
        if (pending.current !== current) return;
        setStatus(next);
        setDialog(next);
      }).catch(() => {
        if (pending.current !== current) return;
        setNotice("Could not open AI connection settings. Try again.");
        finish(false);
      });
    });
  }, [finish]);

  const cancel = useCallback((owner: string) => {
    if (pending.current?.owner === owner) finish(false);
  }, [finish]);

  return (
    <Context.Provider value={{ status, notice, request, cancel }}>
      {children}
      {dialog && <AiProviderDialog initial={dialog} onClose={() => finish(false)} onSaved={(next) => {
        setStatus(next);
        setNotice(next.warning ?? (next.mode === "byom" && next.keyPersistence === "memory"
          ? MEMORY_KEY_NOTICE : "AI connection saved."));
        finish(true);
      }} />}
    </Context.Provider>
  );
}

export function useAiConnection() {
  const context = useContext(Context);
  if (!context) throw new Error("Missing AI connection provider");
  const owner = useId();
  const live = useRef(false);
  const { request, cancel } = context;
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; cancel(owner); };
  }, [cancel, owner]);
  const ensureReady = useCallback(async (continueAfterSetup = false) => {
    const status = await window.skillRecorder.aiConnectionStatus();
    if (!live.current) return false;
    if (aiConnectionReady(status)) return true;
    const saved = await request(owner);
    return saved && continueAfterSetup;
  }, [request, owner]);
  const configure = useCallback(() => request(owner), [request, owner]);
  return { ...context, ensureReady, configure };
}

export function AiConnectionButton() {
  const { status, notice, configure } = useAiConnection();
  return (
    <div className="ai-connection-summary">
      <button className="row-action" onClick={() => void configure()}>AI connection</button>
      <span title={aiDestination(status)}>{status?.mode === "byom" ? status.hasKey ? status.profile?.model : "API key needed" : status?.mode === "github" ? "GitHub Copilot" : "Not configured"}</span>
      {notice && <small role="status">{notice}</small>}
    </div>
  );
}

function AiProviderDialog({
  initial, onSaved, onClose,
}: {
  initial: AiConnectionStatus;
  onSaved(status: AiConnectionStatus): void;
  onClose(): void;
}) {
  const [step, setStep] = useState<"choice" | "byom">(initial.mode === "byom" ? "byom" : "choice");
  const [profile, setProfile] = useState<ByomConfig>(initial.profile ?? {
    provider: "foundry", baseUrl: "", model: "", wireApi: "responses", apiVersion: undefined,
  });
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState(initial);
  const [error, setError] = useState<string | null>(initial.warning ?? null);
  const [manualCommand, setManualCommand] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const attempt = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const titleId = useId();

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current!;
    element.showModal();
    return () => {
      mounted.current = false;
      element.close();
      const id = attempt.current;
      attempt.current = null;
      if (id) void window.skillRecorder.aiConnectionCancel(id).catch(() => {
        console.warn("Could not cancel AI connection setup.");
      });
    };
  }, []);

  const cancel = async () => {
    const id = attempt.current;
    if (!id) { onClose(); return; }
    setCanceling(true);
    try { await window.skillRecorder.aiConnectionCancel(id); }
    catch { if (mounted.current) setError("Could not cancel connection setup. Wait for it to finish."); }
    finally { if (mounted.current) setCanceling(false); }
  };

  const perform = async (operation: (id: string) => Promise<AiConnectionResult>, close = true) => {
    if (attempt.current) return;
    const id = crypto.randomUUID();
    attempt.current = id;
    setBusy(true);
    setError(null);
    setManualCommand(undefined);
    try {
      const result = await operation(id);
      if (!mounted.current || attempt.current !== id) return;
      if (result.ok) {
        setApiKey("");
        setStatus(result.status);
        if (close) onSaved(result.status);
      } else {
        setError(result.error);
        setManualCommand(result.command);
      }
    } catch {
      if (mounted.current) setError("Could not complete AI connection setup. Try again.");
    } finally {
      if (attempt.current === id) attempt.current = null;
      if (mounted.current) setBusy(false);
    }
  };

  const save = () => {
    let parsed: ByomConfig;
    try { parsed = parseByomConfig(profile); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Check the connection fields."); return; }
    void perform((id) => window.skillRecorder.aiConnectionSave(id, parsed, apiKey || undefined));
  };

  const savedKey = status.hasKey && sameCredentialDestination(status.profile, profile);
  return createPortal(
    <dialog ref={dialog} className="sheet ai-connection-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); void cancel(); }}>
      <div className="sheet-head">
        <h2 id={titleId}>{step === "choice" ? "Choose your AI connection" : "Bring your own model"}</h2>
        <button className="ghost" onClick={() => void cancel()} disabled={canceling}>{busy ? "Cancel" : "Close"}</button>
      </div>
      {step === "choice" ? <>
        <p className="sheet-lead">Choose how to power analysis and generation. You can change this later in AI connection.</p>
        <button className="row-action ai-choice" disabled={busy} onClick={() => setStep("byom")}>
          <strong>Bring your own model</strong><span>Use your provider's API key from Microsoft Foundry, OpenAI, Anthropic, or Generic LLM vendors. No GitHub login required, but provider billing applies.</span>
        </button>
        <button className="row-action ai-choice" disabled={busy}
          onClick={() => void perform((id) => window.skillRecorder.aiConnectionGitHub(id))}>
          <strong>GitHub authentication</strong><span>Use your GitHub account to access GitHub Copilot. Choose this if you have a GitHub subscription or if you are a Microsoft Employee.</span>
        </button>
      </> : <>
        <button className="linky" disabled={busy} onClick={() => { setStep("choice"); setError(null); }}>Back to GitHub / BYOM choice</button>
        <form className="ai-provider-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <fieldset disabled={busy}>
            <label>Provider<select value={profile.provider} onChange={(event) => {
              const preset = PROVIDERS.find((item) => item.id === event.target.value)!;
              setProfile({ provider: preset.id, baseUrl: preset.baseUrl, model: "", wireApi: preset.wireApi,
                apiVersion: preset.id === "azure" ? "2024-10-21" : undefined });
              setApiKey("");
              setError(null);
            }}>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
            <label>Base URL<input type="url" required value={profile.baseUrl} placeholder="https://your-resource.openai.azure.com/openai/v1/"
              onChange={(event) => { setProfile({ ...profile, baseUrl: event.target.value }); setApiKey(""); }} /></label>
            <label>{profile.provider === "foundry" || profile.provider === "azure" ? "Deployment name" : "Model ID"}
              <input required value={profile.model} autoComplete="off" onChange={(event) => setProfile({ ...profile, model: event.target.value })} /></label>
            <label>API key<input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} required={!savedKey}
              placeholder={savedKey ? "Saved key (leave empty to keep)" : "Enter your provider API key"}
              onChange={(event) => setApiKey(event.target.value)} /></label>
            <details><summary>Advanced</summary>
              {profile.provider !== "anthropic" && <label>API format<select value={profile.wireApi}
                onChange={(event) => setProfile({ ...profile, wireApi: event.target.value === "responses" ? "responses" : "completions" })}>
                <option value="responses">Responses API</option><option value="completions">Chat Completions API</option>
              </select></label>}
              {profile.provider === "azure" && <label>Azure API version<input required value={profile.apiVersion ?? ""}
                onChange={(event) => setProfile({ ...profile, apiVersion: event.target.value })} /></label>}
              <p className="sheet-lead">Foundry v1 URLs end in /openai/v1/. Versioned Azure endpoints use only the resource host. Choose an API format supported by your deployment.</p>
            </details>
          </fieldset>
          <p className="sheet-lead">The model must support images and tool calling. Test and save sends a small, provider-billed synthetic image/tool test, never a recording.</p>
          <div className="sheet-actions">
            <button type="submit" className="row-action" disabled={busy}>Test and save</button>
            {status.hasKey && <button type="button" className="linky" disabled={busy}
              onClick={() => void perform((id) => window.skillRecorder.aiConnectionForget(id), false)}>Forget key</button>}
          </div>
        </form>
        <small className="ai-storage-notice" role="status">{status.storage === "memory" ? MEMORY_KEY_NOTICE
          : "Your key is remembered using this operating system's secure storage. Forget key removes it from this app, not from your provider."}</small>
      </>}
      {busy && <p role="status" className="sheet-lead">{canceling ? "Canceling..." : step === "choice" ? "Checking GitHub access. Complete any sign-in prompts..." : "Checking the connection..."}</p>}
      {error && <p role="alert" className="sheet-caution">{error}</p>}
      {manualCommand && <p className="sheet-lead">Or sign in manually, then choose GitHub authentication again:
        <code className="signin-command">{manualCommand}</code>
      </p>}
    </dialog>, document.body,
  );
}
