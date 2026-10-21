import type { SkillPreview } from "../common/ipc";

export type SkillPhase = "loading" | "ready" | "planning" | "plan" | "preparing" | "creating" | "stopping" | "done";

export interface SkillReviewState {
  phase: SkillPhase;
  preview: SkillPreview | null;
  reviewOpen: boolean;
  statusLine: string;
  error: string | null;
}

export type SkillReviewAction =
  | { type: "start"; phase: "planning" | "preparing" | "creating" | "stopping"; message: string }
  | { type: "settle"; phase: "ready" | "plan"; error?: string; previewExpired?: boolean }
  | { type: "preview"; preview: SkillPreview }
  | { type: "visibility"; open: boolean }
  | { type: "invalidate" }
  | { type: "progress"; message: string }
  | { type: "error"; error: string }
  | { type: "done" };

export function initialSkillReviewState(hasSkill: boolean): SkillReviewState {
  return { phase: hasSkill ? "loading" : "ready", preview: null, reviewOpen: false, statusLine: "", error: null };
}

export function skillReviewBusy(phase: SkillPhase): boolean {
  return phase === "planning" || phase === "preparing" || phase === "creating" || phase === "stopping";
}

export function skillReviewReducer(state: SkillReviewState, action: SkillReviewAction): SkillReviewState {
  switch (action.type) {
    case "start":
      return { ...state, phase: action.phase, statusLine: action.message, error: null };
    case "settle":
      return {
        ...state,
        phase: action.phase,
        preview: action.previewExpired ? null : state.preview,
        statusLine: "",
        error: action.error ?? null,
      };
    case "preview":
      return { ...state, phase: "plan", preview: action.preview, statusLine: "", error: null };
    case "visibility":
      return { ...state, reviewOpen: action.open };
    case "invalidate":
      return { ...state, preview: null };
    case "progress":
      return { ...state, statusLine: action.message };
    case "error":
      return { ...state, error: action.error };
    case "done":
      return { ...state, phase: "done", preview: null, reviewOpen: false, statusLine: "", error: null };
  }
}

// React state updates are deferred; acquire this guard before the first await.
export class SkillOperationGuard {
  private active: symbol | null = null;
  private canceledSource: symbol | null = null;
  private pending = new Map<symbol, { promise: Promise<void>; resolve: () => void }>();

  begin(): symbol | null {
    if (this.active) return null;
    this.active = Symbol();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.pending.set(this.active, { promise, resolve });
    return this.active;
  }

  isCurrent(operation: symbol): boolean {
    return this.active === operation;
  }

  beginCancellation(): { operation: symbol; originalSettled: Promise<void> } | null {
    if (!this.active || this.canceledSource) return null;
    const original = this.active;
    const originalSettled = this.whenSettled();
    this.active = null;
    const operation = this.begin()!;
    this.canceledSource = original;
    return { operation, originalSettled };
  }

  // Cancellation cannot undo a synchronous file write that already committed.
  // Departure invalidates both identities, so it still rejects late successes.
  commit(operation: symbol): boolean {
    if (!this.isCurrent(operation) && this.canceledSource !== operation) return false;
    this.active = null;
    this.canceledSource = null;
    return true;
  }

  finish(operation: symbol): void {
    this.pending.get(operation)?.resolve();
    this.pending.delete(operation);
    if (this.isCurrent(operation)) {
      this.active = null;
      this.canceledSource = null;
    }
  }

  whenSettled(): Promise<void> {
    return (this.active && this.pending.get(this.active)?.promise) || Promise.resolve();
  }

  invalidate(): boolean {
    const wasActive = this.active !== null;
    this.active = null;
    this.canceledSource = null;
    return wasActive;
  }

  get busy(): boolean {
    return this.active !== null;
  }
}
