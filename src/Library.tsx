import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { Analysis, AnalysisStep } from "../common/analysis";
import type {
  AnalyzeProgress,
  AutomationBuildProgress,
  CopilotSignInResult,
  NarrationStatus,
  SensitiveReport,
  SessionSummary,
  SkillBuildProgress,
  SkillPlacement,
  SkillPreview,
} from "../common/ipc";
import { isCopilotSignedOutError } from "../common/ipc";
import type {
  BuildTarget,
  BuiltSkill,
  SkillArchitecture,
  SkillPlan,
} from "../common/skill";
import {
  ARCHITECTURES,
  DEFAULT_TARGET,
  TARGETS,
  buildTargetFor,
} from "../common/skill";
import type { AutomationPlan, BuiltAutomation } from "../common/automation";
import {
  DEFAULT_NARRATION_LANGUAGE,
  NARRATION_MODEL_DOWNLOAD_LABEL,
  narrationLanguageLabel,
} from "../common/narration";
import {
  AnalysisStepTiles,
  AutomationStepTiles,
  EditableText,
  ScheduleEditor,
  SkillStepTiles,
} from "./plan-edit";
import { formatBytes, formatDur, formatWhen, shortLabel } from "./format";
import { skillPlacementModel, skillTargetFor } from "./skill-placement";
import { SkillReviewModal } from "./SkillReviewModal";
import { initialSkillReviewState, SkillOperationGuard, skillReviewBusy, skillReviewReducer } from "./skill-review-state";
import { SensitiveReview } from "./SensitiveReview";
import { AnalysisRecovery, completeSignIn, type AnalysisRun } from "./analysis-recovery";

export function Library() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [narrationStatus, setNarrationStatus] = useState<NarrationStatus | null>(null);

  const loadSessions = useCallback(async () => {
    const list = await window.skillRecorder.listSessions();
    setSessions(list);
    setLoaded(true);
    setSelectedId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadSessions();
    return window.skillRecorder.onStatusChanged((s) => {
      if (s.state !== "recording") void loadSessions();
    });
  }, [loadSessions]);

  useEffect(() => {
    void window.skillRecorder.narrationStatus().then(setNarrationStatus);
    return window.skillRecorder.onNarrationStatusChanged((next) => {
      setNarrationStatus(next);
      if (next.phase === "idle") void loadSessions();
    });
  }, [loadSessions]);

  const deleteSession = useCallback(async (id: string) => {
    setNotice(null);
    const res = await window.skillRecorder.deleteSession(id);
    if (!res.ok) {
      setNotice(res.error ?? "Could not delete this recording.");
      return;
    }
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      setSelectedId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        return (next[idx] ?? next[next.length - 1]).id;
      });
      return next;
    });
  }, []);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="lib">
      <aside className="lib-list">
        <div className="lib-list-head">
          <span className="eyebrow">Sessions</span>
          <span className="pill">{sessions.length}</span>
        </div>
        {notice && (
          <button className="sess-notice" onClick={() => setNotice(null)} title="Dismiss">
            {notice}
          </button>
        )}
        <div className="lib-list-scroll">
          <SessionsList
            sessions={sessions}
            loaded={loaded}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDelete={deleteSession}
          />
        </div>
      </aside>
      <main className="lib-detail">
        {selected ? (
          <AnalysisWorkspace
            key={selected.id}
            summary={selected}
            narrationStatus={narrationStatus}
            onChanged={loadSessions}
          />
        ) : (
          <div className="detail-empty">
            <span className="eyebrow">No session selected</span>
            <p>Pick a recording on the left to review its reconstructed intent and steps.</p>
          </div>
        )}
      </main>
    </div>
  );
}

/* --- Sessions list -------------------------------------------------------- */

function SessionsList({
  sessions,
  loaded,
  selectedId,
  onSelect,
  onDelete,
}: {
  sessions: SessionSummary[];
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (sessions.length === 0) {
    return <p className="sessions-empty">{loaded ? "No recordings yet." : "Loading…"}</p>;
  }
  return (
    <ul className="sess-list">
      {sessions.map((s) =>
        confirmId === s.id ? (
          <li key={s.id}>
            <div className="sess-confirm" role="alertdialog" aria-label="Confirm delete">
              <div className="sess-confirm-text">
                <span className="sess-confirm-title">Delete this recording?</span>
                <span className="sess-confirm-sub">
                  This cannot be undone.
                  {s.sizeBytes != null && ` Frees ${formatBytes(s.sizeBytes)} from this device.`}
                </span>
              </div>
              <div className="sess-confirm-actions">
                <button className="linky" onClick={() => setConfirmId(null)}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setConfirmId(null);
                    void onDelete(s.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ) : (
          <li key={s.id}>
            <div className="sess-row">
              <button
                className={`sess ${s.id === selectedId ? "on" : ""}`}
                onClick={() => onSelect(s.id)}
              >
                <div className="sess-top">
                  <span className="sess-when">{formatWhen(s.startedAt)}</span>
                  <span className="sess-tags">
                    {s.hasSkill && <span className="tag ok">skill</span>}
                    {s.hasAutomation && <span className="tag auto">automation</span>}
                    {!s.hasSkill && !s.hasAutomation && s.analysis && (
                      <span className="tag an">analyzed</span>
                    )}
                    {!s.hasSkill && !s.hasAutomation && !s.analysis && !s.processed && (
                      <span className="tag warn">processing</span>
                    )}
                    {!s.hasSkill && !s.hasAutomation && !s.analysis && s.processed && (
                      <span className="tag recorded">recorded</span>
                    )}
                  </span>
                </div>
                <div className="sess-intent">
                  {s.analysis
                    ? s.analysis.title?.trim() || shortLabel(s.analysis.intent)
                    : "Not analyzed yet"}
                </div>
                <div className="sess-sub">
                  {s.durationMs != null && <span>{formatDur(s.durationMs)}</span>}
                  {s.sizeBytes != null && (
                    <span
                      className="sess-size"
                      title={`${s.sizeBytes.toLocaleString()} bytes used by this recording`}
                    >
                      {formatBytes(s.sizeBytes)}
                    </span>
                  )}
                  {s.analysis && <span>{s.analysis.stepCount} steps</span>}
                  {s.hasVideo && <span>video</span>}
                  {s.hasAudio && !s.hasNarration && <span>voice pending</span>}
                  {s.hasNarration && <span>voice</span>}
                </div>
              </button>
              <button
                className="sess-del"
                aria-label={`Delete recording from ${formatWhen(s.startedAt)}`}
                title="Delete recording"
                onClick={() => setConfirmId(s.id)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M3 4.5h10M6.4 4.5V3.3c0-.44.36-.8.8-.8h1.6c.44 0 .8.36.8.8v1.2M4.7 4.5l.5 8.2c.02.42.37.75.8.75h4c.42 0 .77-.33.8-.75l.5-8.2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </li>
        ),
      )}
    </ul>
  );
}

/* --- Analysis workspace --------------------------------------------------- */

const DownloadGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M8 2.6v6.2m0 0 2.3-2.3M8 8.8 5.7 6.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3.2 10.4v1.2c0 .6.5 1.1 1.1 1.1h7.4c.6 0 1.1-.5 1.1-1.1v-1.2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SavedGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M3.4 8.4 6.3 11.3 12.6 4.8"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Subtle, per-recording "download a debug bundle" affordance shown in the session
 * header. A quiet download icon packages the whole session (private capture data)
 * into a `.zip` the user can hand to us; a privacy-warning modal gates the actual
 * download. It says nothing about where to send the file — that's shared separately.
 */
function DebugDownload({ sessionId }: { sessionId: string }) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  const download = useCallback(async () => {
    setPhase("saving");
    setErrorMsg("");
    const res = await window.skillRecorder.exportDebugBundle(sessionId);
    if (res.ok) setPhase("saved");
    else if (res.canceled) setPhase("idle");
    else {
      setErrorMsg(res.error ?? "Couldn't create the debug bundle.");
      setPhase("error");
    }
  }, [sessionId]);

  // Let the "Saved" acknowledgement fade back to the quiet icon on its own.
  useEffect(() => {
    if (phase !== "saved") return;
    const t = setTimeout(() => setPhase("idle"), 3200);
    return () => clearTimeout(t);
  }, [phase]);

  // While the warning is up, focus it and close on Escape — matching the app's sheets.
  useEffect(() => {
    if (phase !== "confirm") return;
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPhase("idle");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  const label =
    phase === "saving"
      ? "Preparing debug bundle…"
      : phase === "saved"
        ? "Debug bundle saved"
        : "Download details for debugging";

  return (
    <div className="debug-dl">
      {phase === "error" && (
        <span className="debug-dl-note" title={errorMsg}>
          Couldn't save
        </span>
      )}
      <button
        className={`debug-dl-icon${phase === "saved" ? " is-saved" : ""}`}
        onClick={() => setPhase("confirm")}
        disabled={phase === "saving"}
        aria-label={label}
        title={label}
      >
        {phase === "saving" ? (
          <span className="spinner" aria-hidden />
        ) : phase === "saved" ? (
          <SavedGlyph />
        ) : (
          <DownloadGlyph />
        )}
      </button>

      {phase === "confirm" && (
        <div className="sheet-backdrop" onClick={() => setPhase("idle")}>
          <div
            ref={dialogRef}
            className="sheet debug-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="debug-dl-title"
            aria-describedby="debug-dl-desc"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="sheet-head">
              <span className="sheet-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <rect
                    x="4.4"
                    y="8.7"
                    width="11.2"
                    height="7.9"
                    rx="1.9"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M6.9 8.7V6.7a3.1 3.1 0 0 1 6.2 0v2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                  <circle cx="10" cy="12.4" r="1.1" fill="currentColor" />
                </svg>
              </span>
              <h2 id="debug-dl-title">Includes private information</h2>
            </header>

            <p className="sheet-lead" id="debug-dl-desc">
              This bundle is everything captured in this recording — screen video, screenshots,
              visited URLs, clipboard contents, and any voice narration and transcript. Share it
              only with people you trust.
            </p>

            <div className="sheet-actions">
              <button className="linky" onClick={() => setPhase("idle")}>
                Cancel
              </button>
              <button className="record-cta" onClick={() => void download()}>
                Download .zip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Error banner for the Copilot-backed panels. When the CLI has no credentials the app
 * waits for verified authentication. Only analysis supplies a recovery callback;
 * building, creating and installing always require another explicit user action.
 */
function AnalysisError({
  error,
  onAuthenticated,
  onSignInStart,
  onSignInEnd,
}: {
  error: string;
  onAuthenticated?: () => void | Promise<void>;
  onSignInStart?: () => boolean;
  onSignInEnd?: (canceled: boolean) => void;
}) {
  const [signIn, setSignIn] = useState<CopilotSignInResult | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attempt = useRef<string | null>(null);
  const generation = useRef(0);
  const live = useRef(false);
  const endCallback = useRef(onSignInEnd);
  endCallback.current = onSignInEnd;

  useEffect(() => {
    live.current = true;
    setWaiting(false);
    setSignIn(null);
    setFailure(null);
    return () => {
      live.current = false;
      generation.current++;
      const id = attempt.current;
      attempt.current = null;
      if (id) {
        endCallback.current?.(true);
        void window.skillRecorder.cancelCopilotSignIn(id).catch(() => {
          console.warn("Could not cancel Copilot sign-in during panel cleanup.");
        });
      }
    };
  }, [error]);

  const cancelSignIn = async () => {
    const id = attempt.current;
    if (!id) return;
    const canceledGeneration = generation.current;
    attempt.current = null;
    onSignInEnd?.(true);
    setWaiting(false);
    setFailure(onAuthenticated
      ? "Sign-in canceled. Analysis will not retry automatically."
      : "Sign-in canceled.");
    try {
      await window.skillRecorder.cancelCopilotSignIn(id);
    } catch (err) {
      if (live.current && generation.current === canceledGeneration) {
        setFailure(`Could not cancel sign-in: ${String(err)}`);
      }
    }
  };

  const openSignIn = async () => {
    if (attempt.current) return;
    const id = crypto.randomUUID();
    generation.current++;
    attempt.current = id;
    setWaiting(true);
    setSignIn(null);
    setFailure(null);
    let canceledResult = false;
    try {
      // A false return suppresses stale recovery without suppressing sign-in itself.
      const recover = onSignInStart?.() ?? true;
      const result = await completeSignIn(
        window.skillRecorder.copilotSignIn(id),
        () => live.current && attempt.current === id,
        recover ? onAuthenticated : undefined,
      );
      if (result && live.current && attempt.current === id) {
        canceledResult = !result.ok && result.status === "canceled";
        setSignIn(result);
      }
    } catch (err) {
      if (live.current && attempt.current === id) setFailure(String(err));
    } finally {
      if (live.current && attempt.current === id) {
        attempt.current = null;
        onSignInEnd?.(canceledResult);
        setWaiting(false);
      }
    }
  };

  if (!isCopilotSignedOutError(error)) return <div className="analysis-error">{error}</div>;

  return (
    <div className="analysis-error">
      <p>{error}</p>
      <div className="signin-row">
        <button className="row-action" onClick={() => void openSignIn()} disabled={waiting}>
          {waiting ? "Waiting for browser sign-in…" : "Sign in to Copilot"}
        </button>
        {waiting && (
          <>
            <span role="status">Follow the app prompts and finish signing in in your browser.</span>
            <button className="linky" onClick={() => void cancelSignIn()}>Cancel sign-in</button>
          </>
        )}
        {signIn?.ok && (
          <span>Signed in to Copilot. Try your action again when ready.</span>
        )}
        {signIn && !signIn.ok && (
          <span>{signIn.error ?? (
            signIn.status === "canceled" ? "Sign-in canceled." :
            signIn.status === "timed-out" ? "Sign-in timed out. Try again." :
            "Couldn't sign in to Copilot."
          )}</span>
        )}
        {failure && <span role="alert">{failure}</span>}
      </div>
      {signIn && !signIn.ok && signIn.command && (
        <>
          <p className="signin-manual">Or run this command yourself:</p>
          <code className="signin-command">{signIn.command}</code>
        </>
      )}
    </div>
  );
}

function AnalysisWorkspace({
  summary,
  narrationStatus,
  onChanged,
}: {
  summary: SessionSummary;
  narrationStatus: NarrationStatus | null;
  onChanged: () => void | Promise<void>;
}) {
  const sessionId = summary.id;
  const voicePending = summary.hasAudio && !summary.hasNarration;
  const voiceLanguage = narrationLanguageLabel(
    summary.narrationLanguage ?? DEFAULT_NARRATION_LANGUAGE,
  );
  const voiceBusy =
    narrationStatus?.activeSessionId === sessionId && narrationStatus.phase !== "idle";
  const voiceError =
    narrationStatus?.activeSessionId == null || narrationStatus.activeSessionId === sessionId
      ? narrationStatus?.error
      : null;
  const voiceStale =
    summary.analysis != null &&
    (summary.narrationSegmentCount ?? 0) > 0 &&
    summary.narrationUpdatedAt != null &&
    (summary.analysis.narrationSourceUpdatedAt == null ||
      summary.narrationUpdatedAt > summary.analysis.narrationSourceUpdatedAt);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [signInPending, setSignInPending] = useState(false);
  const signInPendingRef = useRef(false);
  const pendingRecovery = useRef<AnalysisRun | null>(null);
  const recovery = useRef(new AnalysisRecovery());
  const [failedRun, setFailedRun] = useState<AnalysisRun | null>(null);
  const latestRun = useRef<AnalysisRun | null>(null);
  const workspaceLive = useRef(false);
  const [statusLine, setStatusLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Informational summary of what the on-device scan redacted before sending;
  // set alongside a successful analysis, cleared at the start of the next run.
  const [review, setReview] = useState<SensitiveReport | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftIntent, setDraftIntent] = useState("");
  const [confirmReanalysis, setConfirmReanalysis] = useState(false);
  // Directly-editable steps (the source of truth downstream); persisted on a short
  // debounce so typing stays instant. `stepsDirty` gates the persist so seeding from
  // a freshly loaded analysis never writes back.
  const [steps, setSteps] = useState<AnalysisStep[]>([]);
  const stepsDirty = useRef(false);
  const stepsRef = useRef<AnalysisStep[]>([]);
  stepsRef.current = steps;
  // The final stage: pick a target, then build a skill or an automation. A recording
  // that is already exactly one kind opens straight to it; otherwise it opens to the
  // analysis, where "Create…" starts the target picker.
  const initialLaunch: LaunchTarget =
    summary.hasSkill && !summary.hasAutomation
      ? "skill"
      : summary.hasAutomation && !summary.hasSkill
        ? "automation"
        : "none";
  const [launch, setLaunch] = useState<LaunchTarget>(initialLaunch);
  const [chosenArch, setChosenArch] = useState<SkillArchitecture>(DEFAULT_TARGET.architecture);
  useEffect(() => {
    workspaceLive.current = true;
    return () => {
      workspaceLive.current = false;
      recovery.current.invalidate();
      signInPendingRef.current = false;
      pendingRecovery.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    let live = true;
    void Promise.all([
      window.skillRecorder.getAnalysis(sessionId),
      window.skillRecorder.getSensitiveReport(sessionId),
    ]).then(([a, r]) => {
      if (!live) return;
      setAnalysis(a);
      setSteps(a?.steps ?? []);
      stepsDirty.current = false;
      // Rehydrate the redaction summary so it survives reopen (only when the session
      // is actually analyzed — never surface a stale report on an un-analyzed one).
      setReview(a ? r : null);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  // Persist directly-edited steps on a short debounce (no agent, no re-analysis).
  useEffect(() => {
    if (!stepsDirty.current) return;
    const t = setTimeout(() => {
      stepsDirty.current = false;
      void window.skillRecorder.updateAnalysis({ sessionId, steps: stepsRef.current }).then((res) => {
        if (res.ok && res.analysis) setAnalysis(res.analysis);
        void onChanged();
      });
    }, 500);
    return () => clearTimeout(t);
  }, [steps, sessionId, onChanged]);

  // Flush any pending step edits when leaving this session, so nothing is lost.
  useEffect(() => {
    return () => {
      if (stepsDirty.current) {
        void window.skillRecorder.updateAnalysis({ sessionId, steps: stepsRef.current });
        stepsDirty.current = false;
      }
    };
  }, [sessionId]);

  const onStepsChange = useCallback((next: AnalysisStep[]) => {
    stepsDirty.current = true;
    setSteps(next);
  }, []);

  // Single latest status line (no growing log).
  useEffect(() => {
    return window.skillRecorder.onAnalyzeProgress((p: AnalyzeProgress) => {
      if (p.sessionId !== sessionId) return;
      setStatusLine(p.message);
      // The invocation, not a progress event, owns the busy state.
    });
  }, [sessionId]);

  const executeRun = useCallback(
    async (token: AnalysisRun) => {
      latestRun.current = token;
      setEditing(false);
      setDraftTitle("");
      setDraftIntent("");
      setReview(null);
      setError(null);
      setAnalyzing(true);
      setFailedRun(null);
      setStatusLine("Starting…");
      let signedOut = false;
      try {
        const res = await window.skillRecorder.analyze(sessionId);
        if (!workspaceLive.current || !recovery.current.accepts(token)) return;
        if (res.ok && res.analysis) {
          setAnalysis(res.analysis);
          setSteps(res.analysis.steps);
          stepsDirty.current = false;
          // Preserve the existing narration/redaction pipeline and result handling.
          setReview(res.review ?? null);
        } else {
          const message = res.error ?? "Analysis failed";
          signedOut = isCopilotSignedOutError(message);
          setError(message);
          setFailedRun(token);
        }
      } catch (err) {
        if (workspaceLive.current && recovery.current.accepts(token)) {
          const message = String(err);
          signedOut = isCopilotSignedOutError(message);
          setError(message);
          setFailedRun(token);
        }
      } finally {
        if (workspaceLive.current && recovery.current.isCurrent(token)) {
          recovery.current.finishRun(token, signedOut);
          setAnalyzing(false);
          try {
            await onChanged();
          } catch (err) {
            // A refresh failure must not be mistaken for an interrupted analysis.
            if (workspaceLive.current && latestRun.current === token) {
              setFailedRun(null);
              setError(`Could not refresh recordings: ${String(err)}`);
            }
          }
        }
      }
    },
    [sessionId, onChanged],
  );

  const run = useCallback(async () => {
    if (signInPendingRef.current) return;
    const token = recovery.current.beginRun();
    if (token) await executeRun(token);
  }, [executeRun]);

  const onSignInStart = useCallback(() => {
    signInPendingRef.current = true;
    setSignInPending(true);
    setConfirmReanalysis(false);
    const recover = failedRun != null && recovery.current.beginSignIn(failedRun);
    pendingRecovery.current = recover ? failedRun : null;
    return recover;
  }, [failedRun]);

  const onSignInEnd = useCallback((canceled: boolean) => {
    signInPendingRef.current = false;
    if (pendingRecovery.current) recovery.current.endSignIn(pendingRecovery.current, canceled);
    pendingRecovery.current = null;
    if (workspaceLive.current) setSignInPending(false);
  }, []);

  const retryAfterSignIn = useCallback(async () => {
    if (!workspaceLive.current || !failedRun) return;
    const token = recovery.current.retry(failedRun);
    if (!token) return;
    signInPendingRef.current = false;
    setSignInPending(false);
    await executeRun(token);
  }, [failedRun, executeRun]);

  const cancel = useCallback(async () => {
    const token = latestRun.current;
    recovery.current.cancelRun();
    setStatusLine("Stopping…");
    try {
      await window.skillRecorder.cancelAnalysis(sessionId);
    } catch (err) {
      if (workspaceLive.current && latestRun.current === token) {
        setFailedRun(null);
        setError(`Could not cancel analysis: ${String(err)}`);
      }
    }
  }, [sessionId]);

  const startEdit = useCallback(() => {
    if (!analysis) return;
    setDraftTitle(analysis.title ?? "");
    setDraftIntent(analysis.intent);
    setError(null);
    setFailedRun(null);
    setEditing(true);
  }, [analysis]);

  const saveEdit = useCallback(async () => {
    const res = await window.skillRecorder.updateAnalysis({
      sessionId,
      title: draftTitle.trim(),
      intent: draftIntent.trim() || undefined,
    });
    if (res.ok && res.analysis) {
      setAnalysis(res.analysis);
      setEditing(false);
    } else {
      setFailedRun(null);
      setError(res.error ?? "Could not save your changes");
    }
    void onChanged();
  }, [sessionId, draftTitle, draftIntent, onChanged]);

  if (launch === "picker") {
    return (
      <TargetPicker
        startedAt={summary.startedAt}
        onPick={(t) => {
          setChosenArch(t.architecture);
          setLaunch(t.kind);
        }}
        onClose={() => setLaunch("none")}
      />
    );
  }

  if (launch === "skill") {
    return (
      <SkillBuilderView
        sessionId={sessionId}
        architecture={chosenArch}
        startedAt={summary.startedAt}
        hasSkill={summary.hasSkill}
        onClose={() => {
          setLaunch("none");
          void onChanged();
        }}
      />
    );
  }

  if (launch === "automation") {
    return (
      <AutomationBuilderView
        sessionId={sessionId}
        architecture={chosenArch}
        startedAt={summary.startedAt}
        hasAutomation={summary.hasAutomation}
        onClose={() => {
          setLaunch("none");
          void onChanged();
        }}
      />
    );
  }

  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">Analysis</span>
          <span className="ws-when">{formatWhen(summary.startedAt)}</span>
        </div>
        <DebugDownload sessionId={sessionId} />
      </div>

      <div className="ws-body">
        {voicePending && voiceError && !analyzing && (
          <p className="voice-analysis-note">
            Couldn't transcribe your {voiceLanguage} voice, so this analysis doesn't include it.
            Your audio is saved — analyzing again will retry.
          </p>
        )}

        {voiceStale && !analyzing && !signInPending && (
          <div className="voice-card">
            <div className="voice-card-copy">
              <strong>Voice transcript added after this analysis</strong>
              <span>Re-analyze to include it. This replaces the current summary and any edits.</span>
            </div>
            {confirmReanalysis ? (
              <div className="voice-card-actions">
                <button className="linky" onClick={() => setConfirmReanalysis(false)}>
                  Cancel
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setConfirmReanalysis(false);
                    void run();
                  }}
                >
                  Replace analysis
                </button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setConfirmReanalysis(true)}>
                Re-analyze with voice
              </button>
            )}
          </div>
        )}

        {!summary.processed && (
          <p className="ws-note">Still processing this recording… try again in a moment.</p>
        )}

        {summary.processed && !analysis && !analyzing && (
          <div className="ws-empty">
            <p className="ws-empty-lead">See what you did in this recording, step by step.</p>
            <button className="record-cta" onClick={() => void run()} disabled={signInPending}>
              Analyze recording
            </button>
            <details className="analyze-disclosure">
              <summary>What gets sent to GitHub Copilot</summary>
              <p>
                When you choose Analyze, the event timeline (window and document titles, URLs, and
                clipboard previews), plus screen images, narration text, and other content you
                provide, are sent to GitHub&apos;s cloud service for processing by GitHub Copilot.{" "}
                <span className="cloud-analysis-caution">
                  Do not analyze a recording that may contain passwords, access tokens, API keys,
                  credentials, secrets, or other sensitive or confidential information.
                </span>{" "}
                By default, before anything is sent, this computer hides sensitive details like
                passwords, keys, emails, and card or ID numbers from the text and your screen
                images. You can turn this off in What&apos;s recorded for more accurate analysis. It
                can miss things, so it is a safety net, not a guarantee.
              </p>
            </details>
            {voicePending && (
              <p className="voice-analysis-note">
                {narrationStatus?.model === "ready"
                  ? `Your ${voiceLanguage} voice is transcribed in the same language first, then analyzed.`
                  : `Your ${voiceLanguage} voice is transcribed in the same language first, then analyzed. The first run downloads a ${NARRATION_MODEL_DOWNLOAD_LABEL} voice model once.`}
              </p>
            )}
          </div>
        )}

        {summary.processed && review && !analyzing && (
          <SensitiveReview report={review} onDismiss={() => setReview(null)} />
        )}

        {analyzing && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">
              {voiceBusy ? narrationWorkLabel(narrationStatus) : statusLine || "Working…"}
            </span>
            <button className="linky status-cancel" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}

        {analyzing && narrationStatus?.phase === "downloading" && (
          <p className="voice-analysis-note">
            First analysis downloads the ~250 MB voice model once — later runs skip this.
          </p>
        )}

        {error && (
          <AnalysisError
            error={error}
            onSignInStart={onSignInStart}
            onSignInEnd={onSignInEnd}
            onAuthenticated={failedRun && !failedRun.retried ? retryAfterSignIn : undefined}
          />
        )}

        {analysis && !analyzing && !signInPending && (
          <div className="ws-read">
            <div className="summary">
              <div className="summary-head">
                <span className="eyebrow">What you did</span>
                {!editing && (
                  <button className="linky" onClick={startEdit}>
                    Edit
                  </button>
                )}
              </div>

              {editing ? (
                <div className="summary-edit">
                  <label className="edit-field">
                    <span className="edit-label">Name</span>
                    <input
                      className="edit-title"
                      value={draftTitle}
                      placeholder="Short name, e.g. Research habit articles"
                      autoFocus
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void saveEdit();
                        } else if (e.key === "Escape") setEditing(false);
                      }}
                    />
                    <span className="edit-hint">Appears in your sessions list</span>
                  </label>
                  <label className="edit-field">
                    <span className="edit-label">Goal</span>
                    <textarea
                      className="edit-intent"
                      value={draftIntent}
                      placeholder="One sentence: what were you trying to do?"
                      onChange={(e) => setDraftIntent(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(false);
                      }}
                    />
                  </label>
                  <div className="edit-actions">
                    <button className="linky" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                    <button className="secondary" onClick={() => void saveEdit()}>
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h2 className="summary-text">{analysis.intent}</h2>
                  {analysis.intentRationale && (
                    <p className="summary-why">{analysis.intentRationale}</p>
                  )}
                </>
              )}
            </div>

            <div className="story-edit">
              <div className="summary-head">
                <span className="eyebrow">Steps</span>
                <span className="edit-hint">Click any step to edit · reorder, add or remove — saved automatically</span>
              </div>
              <AnalysisStepTiles steps={steps} onChange={onStepsChange} />
            </div>
          </div>
        )}
      </div>

      {analysis && !analyzing && !signInPending && (
        <div className="ws-foot">
          <span className="foot-status">{launchFootStatus(summary)}</span>
          <div className="ws-foot-actions">
            {summary.hasSkill && (
              <button className="secondary" onClick={() => setLaunch("skill")} title="Open the skill built from this recording">
                Open skill →
              </button>
            )}
            {summary.hasAutomation && (
              <button
                className="secondary"
                onClick={() => setLaunch("automation")}
                title="Open the automation built from this recording"
              >
                Open automation →
              </button>
            )}
            <button
              className="record-cta"
              onClick={() => setLaunch("picker")}
              title="Turn this recording into a skill or an automation"
            >
              {summary.hasSkill || summary.hasAutomation ? "Create another →" : "Create…"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function narrationWorkLabel(status: NarrationStatus | null): string {
  if (!status) return "Working…";
  if (status.phase === "transcribing") return "Transcribing voice…";
  if (status.phase === "loading") return "Preparing voice model…";
  if (status.phase === "downloading") {
    return status.progress == null
      ? "Downloading voice model…"
      : `Downloading voice model… ${status.progress}%`;
  }
  return "Working…";
}

/* --- Final stage: target picker + builders -------------------------------- */

/** Which final-stage surface the analysis workspace is showing. */
type LaunchTarget = "none" | "picker" | "skill" | "automation";

function launchFootStatus(summary: SessionSummary): string {
  if (summary.hasSkill && summary.hasAutomation) return "Skill & automation created";
  if (summary.hasSkill) return "Skill created";
  if (summary.hasAutomation) return "Automation created";
  return "";
}

/** "What do you want to build?" — picks both kind and architecture up front. */
function TargetPicker({
  startedAt,
  onPick,
  onClose,
}: {
  startedAt: number | null;
  onPick: (target: BuildTarget) => void;
  onClose: () => void;
}) {
  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">Create</span>
          <span className="ws-when">{formatWhen(startedAt)}</span>
        </div>
        <button className="ghost" onClick={onClose} title="Back to the analysis">
          Cancel
        </button>
      </div>
      <div className="ws-body">
        <div className="sb-arch">
          <p className="sb-lead">What do you want to build from this recording?</p>
          <div className="arch-grid">
            {TARGETS.map((t) => (
              <button
                key={`${t.kind}:${t.architecture}`}
                className="arch-card"
                disabled={!t.enabled}
                onClick={() => t.enabled && onPick(t)}
              >
                <span className="arch-name">{t.label}</span>
                <span className="arch-note">{t.enabled ? t.note : "Coming soon"}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* --- Skill builder ------------------------------------------------------- */

type BuildPhase = "loading" | "ready" | "planning" | "plan" | "creating" | "done";

function SkillBuilderView({
  sessionId,
  architecture: initialArch,
  startedAt,
  hasSkill,
  onClose,
}: {
  sessionId: string;
  architecture: SkillArchitecture;
  startedAt: number | null;
  hasSkill: boolean;
  onClose: () => void;
}) {
  const defaultPlacementFor = useCallback(
    (architecture: SkillArchitecture): SkillPlacement =>
      skillPlacementModel(skillTargetFor(architecture)).defaultPlacement,
    [],
  );
  // If this recording is already a skill, hold on a spinner until we've loaded it,
  // so we never flash the planning state before jumping to the skill.
  const [{ phase, preview, reviewOpen, statusLine, error }, dispatch] = useReducer(
    skillReviewReducer, hasSkill, initialSkillReviewState,
  );
  const [architecture, setArchitecture] = useState<SkillArchitecture>(initialArch);
  const [plan, setPlan] = useState<SkillPlan | null>(null);
  const [exportedPath, setExportedPath] = useState("");
  const [builtName, setBuiltName] = useState("");
  const operations = useRef(new SkillOperationGuard());
  const flowVersion = useRef(0);
  const stopping = useRef(false);
  const mounted = useRef(false);
  const previewRef = useRef<SkillPreview | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<SkillPlacement>(() => defaultPlacementFor(initialArch));
  const placementModel = useMemo(() => skillPlacementModel(skillTargetFor(architecture)), [architecture]);

  const discardPreview = useCallback(async (id: string, reportError = false) => {
    const version = flowVersion.current;
    try {
      const result = await window.skillRecorder.discardSkillPreview(sessionId, id);
      if (!result.ok) throw new Error(result.error ?? "Could not discard the preview");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (reportError && mounted.current && flowVersion.current === version) {
        dispatch({ type: "error", error: message });
      }
      else console.warn("Could not discard skill preview", cause);
    }
  }, [sessionId]);

  const invalidatePreview = useCallback(() => {
    flowVersion.current++;
    const previous = previewRef.current;
    previewRef.current = null;
    dispatch({ type: "invalidate" });
    if (previous) void discardPreview(previous.id, true);
  }, [discardPreview]);

  const updatePlan = useCallback((part: Partial<SkillPlan>) => {
    invalidatePreview();
    setPlan((prev) => (prev ? { ...prev, ...part } : prev));
  }, [invalidatePreview]);

  // Leaving the builder (session switch or Close) discards an in-progress plan —
  // we don't save drafts — so stop any run that's still going in the background.
  useEffect(() => {
    mounted.current = true;
    const guard = operations.current;
    return () => {
      mounted.current = false;
      flowVersion.current++;
      if (guard.invalidate()) {
        void window.skillRecorder.cancelSkill(sessionId).then((result) => {
          if (!result.ok) throw new Error("Could not cancel skill work");
        }).catch((cause: unknown) => {
          console.warn("Could not cancel skill work on departure", cause);
        });
      }
      const previous = previewRef.current;
      previewRef.current = null;
      if (previous) void discardPreview(previous.id);
    };
  }, [sessionId, discardPreview]);

  // Reopen straight to the exported state if this recording already has a skill.
  useEffect(() => {
    let live = true;
    const version = flowVersion.current;
    void window.skillRecorder.getSkill(sessionId).then((s: BuiltSkill | null) => {
      if (!live || flowVersion.current !== version) return;
      if (s?.exportedPath) {
        setBuiltName(s.name);
        setExportedPath(s.exportedPath);
        setArchitecture(s.architecture);
        // We don't persist how it was placed, so reopening infers the architecture's
        // current default placement from the manifest.
        setPlacement(defaultPlacementFor(s.architecture));
        if (s.plan) setPlan(s.plan);
        dispatch({ type: "done" });
      } else if (hasSkill) {
        // We expected a skill but couldn't load it; fall back to the ready screen.
        dispatch({ type: "settle", phase: "ready" });
      }
    }).catch((cause: unknown) => {
      if (live && flowVersion.current === version) dispatch({
        type: "settle", phase: "ready",
        error: cause instanceof Error ? cause.message : "Could not open the skill",
      });
    });
    return () => {
      live = false;
    };
  }, [sessionId, hasSkill, defaultPlacementFor]);

  useEffect(() => {
    return window.skillRecorder.onSkillProgress((p: SkillBuildProgress) => {
      if (p.sessionId === sessionId && mounted.current && operations.current.busy && !stopping.current) {
        dispatch({ type: "progress", message: p.message });
      }
    });
  }, [sessionId]);

  const runPlan = useCallback(async () => {
    const operation = operations.current.begin();
    if (!operation) return;
    invalidatePreview();
    flowVersion.current++;
    dispatch({ type: "start", phase: "planning", message: "Planning the skill…" });
    try {
      const res = await window.skillRecorder.buildSkill({ sessionId, architecture });
      if (!mounted.current || !operations.current.isCurrent(operation)) return;
      if (res.ok && res.plan) {
        setPlan(res.plan);
        dispatch({ type: "settle", phase: "plan" });
      } else {
        dispatch({ type: "settle", phase: "ready", error: res.error ?? "Planning failed" });
      }
    } catch (cause) {
      if (mounted.current && operations.current.isCurrent(operation)) {
        dispatch({ type: "settle", phase: "ready", error: cause instanceof Error ? cause.message : "Planning failed" });
      }
    } finally {
      operations.current.finish(operation);
    }
  }, [sessionId, architecture, invalidatePreview]);

  const review = useCallback(async () => {
    if (!plan) return;
    dispatch({ type: "visibility", open: true });
    if (previewRef.current) return;
    const operation = operations.current.begin();
    if (!operation) return;
    flowVersion.current++;
    dispatch({ type: "start", phase: "preparing", message: "Preparing SKILL.md preview…" });
    try {
      const res = await window.skillRecorder.prepareSkill(sessionId, plan);
      if (!mounted.current || !operations.current.isCurrent(operation)) {
        if (res.preview) void discardPreview(res.preview.id);
        return;
      }
      if (res.ok && res.preview) {
        previewRef.current = res.preview;
        dispatch({ type: "preview", preview: res.preview });
      } else {
        dispatch({ type: "settle", phase: "plan", error: res.error ?? "Could not prepare the preview" });
      }
    } catch (cause) {
      if (mounted.current && operations.current.isCurrent(operation)) {
        dispatch({ type: "settle", phase: "plan", error: cause instanceof Error ? cause.message : "Could not prepare the preview" });
      }
    } finally {
      operations.current.finish(operation);
    }
  }, [sessionId, plan, discardPreview]);

  const place = useCallback(
    async (which: SkillPlacement) => {
      if (!plan) return;
      const operation = operations.current.begin();
      if (!operation) return;
      flowVersion.current++;
      dispatch({ type: "start", phase: "creating", message: which === "export" ? "Exporting the skill…" : "Writing the skill…" });
      try {
        const res = await window.skillRecorder.createSkill(sessionId, plan, which, previewRef.current?.id);
        if (!mounted.current) return;
        if (res.ok && res.skill) {
          if (!operations.current.commit(operation)) return;
          setBuiltName(res.skill.name);
          setExportedPath(res.path ?? res.skill.exportedPath ?? "");
          setPlacement(res.placement ?? which);
          previewRef.current = null;
          dispatch({ type: "done" });
        } else {
          if (!operations.current.isCurrent(operation)) return;
          // Folder-picker cancellation and placement failures both retain the candidate.
          // An expired candidate must be reviewed again explicitly, never silently regenerated.
          if (res.previewExpired) previewRef.current = null;
          dispatch({
            type: "settle",
            phase: "plan",
            previewExpired: res.previewExpired,
            error: res.canceled ? undefined : res.error ?? "Could not create the skill",
          });
        }
      } catch (cause) {
        if (mounted.current && operations.current.isCurrent(operation)) {
          dispatch({ type: "settle", phase: "plan", error: cause instanceof Error ? cause.message : "Could not create the skill" });
        }
      } finally {
        operations.current.finish(operation);
      }
    },
    [sessionId, plan],
  );

  const cancelRun = useCallback(async () => {
    if (stopping.current || !operations.current.busy) return;
    const cancellation = operations.current.beginCancellation();
    if (!cancellation) return;
    stopping.current = true;
    flowVersion.current++;
    const { operation, originalSettled } = cancellation;
    dispatch({ type: "start", phase: "stopping", message: "Stopping…" });
    let error: string | undefined;
    try {
      const res = await window.skillRecorder.cancelSkill(sessionId);
      if (!res.ok) throw new Error("Could not cancel skill work");
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not cancel skill work";
    }
    // Acknowledging cancellation only marks the backend operation. Its original
    // request may still own a model turn or an open native folder picker.
    try {
      await originalSettled;
      if (mounted.current && operations.current.isCurrent(operation)) {
        dispatch({ type: "settle", phase: plan ? "plan" : "ready", error });
      }
    } finally {
      operations.current.finish(operation);
      stopping.current = false;
    }
  }, [sessionId, plan]);

  const restoreReviewFocus = useCallback(() => {
    if (mounted.current) (doneRef.current ?? reviewButtonRef.current ?? workspaceRef.current)?.focus();
  }, []);
  useEffect(() => {
    if (phase === "done") doneRef.current?.focus();
  }, [phase]);
  const busy = skillReviewBusy(phase);

  return (
    <section className="ws skill-builder" ref={workspaceRef} tabIndex={-1}>
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">{phase === "done" ? "Skill" : "Create skill"}</span>
          <span className="ws-when">{formatWhen(startedAt)}</span>
        </div>
        <button
          className="ghost"
          onClick={onClose}
          disabled={busy}
          title={phase === "done" ? "View this recording's analysis" : "Back to the analysis"}
        >
          {phase === "done" ? "Analysis" : "Close"}
        </button>
      </div>

      <div className="ws-body">
        {error && <AnalysisError error={error} />}

        {phase === "loading" && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">Opening the skill…</span>
          </div>
        )}

        {phase === "ready" && (
          <div className="sb-arch">
            <p className="sb-lead">Build a {archLabel(architecture)} skill from this recording.</p>
            <button className="record-cta" onClick={() => void runPlan()}>
              Plan the skill →
            </button>
          </div>
        )}

        {busy && (
          <div className="status-line" role="status">
            <span className="spinner" />
            <span className="status-text">{statusLine || "Working…"}</span>
            <button className="linky status-cancel" onClick={cancelRun} disabled={phase === "stopping"}>
              Cancel
            </button>
            {(phase === "preparing" || preview) && (
              <button className="ghost" ref={reviewButtonRef} onClick={() => dispatch({ type: "visibility", open: true })}>
                Review SKILL.md
              </button>
            )}
          </div>
        )}

        {phase === "plan" && plan && (
          <div className="sb-plan">
            <div className="sb-planhead">
              <EditableText
                as="div"
                className="sb-title ed-title"
                value={plan.title}
                placeholder="Skill title"
                ariaLabel="Skill title"
                onChange={(v) => updatePlan({ title: v })}
              />
              <code className="sb-slug">{plan.name}</code>
            </div>
            <EditableText
              as="p"
              multiline
              className="sb-desc ed-desc"
              value={plan.description}
              placeholder="One-line description of what this skill does"
              ariaLabel="Skill description"
              onChange={(v) => updatePlan({ description: v })}
            />

            <div className="sb-sec">
              <span className="eyebrow">What the skill will do</span>
              <p className="sb-refine-hint">
                Click any step to edit, or a highlighted value to change it. Reorder, add or remove as needed.
              </p>
              <SkillStepTiles
                steps={plan.steps}
                onChange={(steps) => updatePlan({ steps })}
                values={plan.values}
                onChangeValues={(values) => updatePlan({ values })}
              />
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="sb-done" ref={doneRef} tabIndex={-1}>
            <div className="sb-check" aria-hidden>
              ✓
            </div>
            <h2 className="sb-title">
              {placement === "install" ? placementModel.installDoneTitle : "Skill exported"}
            </h2>
            <p>
              <code className="sb-slug">{builtName}</code>{" "}
              {placement === "install"
                ? placementModel.installDoneMessage
                : `is built for ${archLabel(architecture)}. Install it wherever ${archLabel(architecture)} loads skills.`}
            </p>
            {exportedPath && <p className="sb-path">{exportedPath}</p>}
          </div>
        )}
      </div>

      {phase === "plan" && plan && (
        <div className="ws-foot">
          <span className="foot-status" />
          <div className="ws-foot-actions">
            <button className="ghost" ref={reviewButtonRef} onClick={() => void review()}>
              Review SKILL.md
            </button>
            {placementModel.actions.map((action) => (
              <button
                key={action.placement}
                className={action.primary ? "record-cta" : "ghost"}
                onClick={() => void place(action.placement)}
                title={action.title}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="ws-foot">
          <span className="foot-status">Skill created</span>
          <div className="ws-foot-actions">
            {exportedPath && (
              <button className="record-cta" onClick={() => void window.skillRecorder.revealSkill(sessionId)}>
                Reveal file
              </button>
            )}
          </div>
        </div>
      )}
      {reviewOpen && (
        <SkillReviewModal
          preview={preview}
          busy={busy}
          stopping={phase === "stopping"}
          statusLine={statusLine}
          error={error}
          placementModel={placementModel}
          onPlace={(which) => void place(which)}
          onPrepare={() => void review()}
          onCancel={() => void cancelRun()}
          onClose={() => dispatch({ type: "visibility", open: false })}
          restoreFocus={restoreReviewFocus}
        />
      )}
    </section>
  );
}

function archLabel(id: SkillArchitecture): string {
  return ARCHITECTURES.find((a) => a.id === id)?.label ?? id;
}

/* --- Automation builder --------------------------------------------------- */

function AutomationBuilderView({
  sessionId,
  architecture: initialArch,
  startedAt,
  hasAutomation,
  onClose,
}: {
  sessionId: string;
  architecture: SkillArchitecture;
  startedAt: number | null;
  hasAutomation: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<BuildPhase>(hasAutomation ? "loading" : "ready");
  const [architecture, setArchitecture] = useState<SkillArchitecture>(initialArch);
  const [plan, setPlan] = useState<AutomationPlan | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState("");
  const [builtName, setBuiltName] = useState("");
  const canceled = useRef(false);
  const inFlight = useRef(false);
  // The initial architecture can reflect a prior skill choice while a saved automation loads.
  const automationInstallTargetLabel =
    phase === "done"
      ? buildTargetFor(architecture, "automation").installTargetLabel
      : "";

  const updatePlan = useCallback((part: Partial<AutomationPlan>) => {
    setPlan((prev) => (prev ? { ...prev, ...part } : prev));
  }, []);

  useEffect(() => {
    return () => {
      if (inFlight.current) void window.skillRecorder.cancelAutomation(sessionId);
    };
  }, [sessionId]);

  // Reopen straight to the exported state if this recording already has one.
  useEffect(() => {
    let live = true;
    void window.skillRecorder.getAutomation(sessionId).then((a: BuiltAutomation | null) => {
      if (!live) return;
      if (a?.exportedPath) {
        setBuiltName(a.name);
        setExportedPath(a.exportedPath);
        setArchitecture(a.architecture);
        if (a.plan) setPlan(a.plan);
        setPhase("done");
      } else if (hasAutomation) {
        setPhase("ready");
      }
    });
    return () => {
      live = false;
    };
  }, [sessionId, hasAutomation]);

  useEffect(() => {
    return window.skillRecorder.onAutomationProgress((p: AutomationBuildProgress) => {
      if (p.sessionId === sessionId) setStatusLine(p.message);
    });
  }, [sessionId]);

  const runPlan = useCallback(async () => {
    canceled.current = false;
    inFlight.current = true;
    setError(null);
    setStatusLine("Planning the automation…");
    setPhase("planning");
    const res = await window.skillRecorder.buildAutomation({ sessionId, architecture });
    inFlight.current = false;
    if (res.ok && res.plan) {
      setPlan(res.plan);
      setPhase("plan");
    } else if (!canceled.current) {
      setError(res.error ?? "Planning failed");
      setPhase("ready");
    }
  }, [sessionId, architecture]);

  const create = useCallback(async () => {
    if (!plan) return;
    canceled.current = false;
    inFlight.current = true;
    setError(null);
    setStatusLine("Writing the automation…");
    setPhase("creating");
    const res = await window.skillRecorder.createAutomation(sessionId, plan);
    inFlight.current = false;
    if (res.ok && res.automation) {
      setBuiltName(res.automation.name);
      setExportedPath(res.path ?? res.automation.exportedPath ?? "");
      setPhase("done");
    } else if (!canceled.current) {
      setError(res.error ?? "Could not create the automation");
      setPhase("plan");
    }
  }, [sessionId, plan]);

  const cancelRun = useCallback(async () => {
    canceled.current = true;
    inFlight.current = false;
    setStatusLine("Stopping…");
    await window.skillRecorder.cancelAutomation(sessionId);
    setPhase(plan ? "plan" : "ready");
  }, [sessionId, plan]);

  const busy = phase === "planning" || phase === "creating";

  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">{phase === "done" ? "Automation" : "Create automation"}</span>
          <span className="ws-when">{formatWhen(startedAt)}</span>
        </div>
        <button
          className="ghost"
          onClick={onClose}
          disabled={busy}
          title={phase === "done" ? "View this recording's analysis" : "Back to the analysis"}
        >
          {phase === "done" ? "Analysis" : "Close"}
        </button>
      </div>

      <div className="ws-body">
        {error && <AnalysisError error={error} />}

        {phase === "loading" && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">Opening the automation…</span>
          </div>
        )}

        {phase === "ready" && (
          <div className="sb-arch">
            <p className="sb-lead">Build a {archLabel(architecture)} automation from this recording.</p>
            <button className="record-cta" onClick={() => void runPlan()}>
              Plan the automation →
            </button>
          </div>
        )}

        {busy && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">{statusLine || "Working…"}</span>
            <button className="linky status-cancel" onClick={cancelRun}>
              Cancel
            </button>
          </div>
        )}

        {phase === "plan" && plan && (
          <div className="sb-plan">
            <div className="sb-planhead">
              <EditableText
                as="div"
                className="sb-title ed-title"
                value={plan.title}
                placeholder="Automation title"
                ariaLabel="Automation title"
                onChange={(v) => updatePlan({ title: v })}
              />
              <code className="sb-slug">{plan.name}</code>
            </div>
            <EditableText
              as="p"
              multiline
              className="sb-desc ed-desc"
              value={plan.description}
              placeholder="One-line description of what this automation does"
              ariaLabel="Automation description"
              onChange={(v) => updatePlan({ description: v })}
            />

            <div className="sb-sec">
              <span className="eyebrow">When it runs</span>
              <p className="sb-refine-hint">
                A recording has no schedule of its own — set when this automation should run.
              </p>
              <ScheduleEditor
                schedule={plan.trigger.schedule}
                onChange={(schedule) => updatePlan({ trigger: { ...plan.trigger, schedule } })}
              />
              {plan.trigger.type === "condition" && plan.trigger.condition && (
                <span className="trigger-cond">Only when: {plan.trigger.condition}</span>
              )}
            </div>

            <div className="sb-sec">
              <span className="eyebrow">What the automation will do</span>
              <p className="sb-refine-hint">
                Click any step to edit, or a highlighted value to change it. Reorder, add or remove as needed.
              </p>
              <AutomationStepTiles
                steps={plan.steps}
                onChange={(steps) => updatePlan({ steps })}
                values={plan.values}
                onChangeValues={(values) => updatePlan({ values })}
              />
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="sb-done">
            <div className="sb-check" aria-hidden>
              ✓
            </div>
            <h2 className="sb-title">Automation ready</h2>
            <p>
              <code className="sb-slug">{builtName}</code> is built for {archLabel(architecture)}.
            </p>
            {exportedPath && <p className="sb-path">{exportedPath}</p>}
            <p className="sb-import-hint">
              Import it into {automationInstallTargetLabel}: open{" "}
              {automationInstallTargetLabel} → Automations → Import, and choose this bundle
              folder.
            </p>
          </div>
        )}
      </div>

      {phase === "plan" && plan && (
        <div className="ws-foot">
          <span className="foot-status" />
          <div className="ws-foot-actions">
            <button
              className="record-cta"
              onClick={() => void create()}
              title="Create and export the automation bundle"
            >
              Create &amp; export automation
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="ws-foot">
          <span className="foot-status">Automation created</span>
          <div className="ws-foot-actions">
            {exportedPath && (
              <button
                className="record-cta"
                onClick={() => void window.skillRecorder.revealAutomation(sessionId)}
              >
                Reveal bundle
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
