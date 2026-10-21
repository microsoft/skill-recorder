import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import type { SkillPlacement, SkillPreview } from "../common/ipc";
import type { SkillPlacementModel } from "./skill-placement";

export function SkillReviewModal({
  preview,
  busy,
  stopping,
  statusLine,
  error,
  placementModel,
  onPlace,
  onPrepare,
  onCancel,
  onClose,
  restoreFocus,
}: {
  preview: SkillPreview | null;
  busy: boolean;
  stopping: boolean;
  statusLine: string;
  error: string | null;
  placementModel: SkillPlacementModel;
  onPlace: (placement: SkillPlacement) => void;
  onPrepare: () => void;
  onCancel: () => void;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = dialog.current!;
    const backdrop = node.parentElement!;
    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.focus();

    const keepFocus = (event: FocusEvent) => {
      if (!node.contains(event.target as Node)) node.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const focusable = [...node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        )].filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) {
          event.preventDefault();
          node.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", keepFocus);
      for (const { element, inert } of background) element.inert = inert;
      document.body.style.overflow = previousOverflow;
      queueMicrotask(restoreFocus);
    };
  }, [restoreFocus]);

  return createPortal(
    <div className="sheet-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialog}
        className="sheet skill-review-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="sheet-head">
          <h2 id={titleId}>Review SKILL.md</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <p className="sheet-lead" id={descriptionId}>
          Read-only file preview, including frontmatter. Nothing is installed or exported until you choose an action below.
          Closing this window keeps the preview; editing the plan discards it.
        </p>
        {error && <p className="sheet-caution" role="alert">{error}</p>}
        {busy && (
          <div className="status-line" role="status">
            <span className="spinner" aria-hidden="true" />
            <span className="status-text">{statusLine || "Working…"}</span>
            <button className="linky status-cancel" onClick={onCancel} disabled={stopping}>Cancel</button>
          </div>
        )}
        {preview && (
          <pre className="skill-review-source" tabIndex={0} aria-label="SKILL.md source">
            <code>{preview.markdown}</code>
          </pre>
        )}
        {!preview && !busy && (
          <button className="ghost" onClick={onPrepare}>Prepare preview</button>
        )}
        <div className="sheet-actions skill-review-actions">
          {placementModel.actions.map((action) => (
            <button
              key={action.placement}
              className={action.primary ? "record-cta" : "ghost"}
              disabled={busy || !preview}
              onClick={() => onPlace(action.placement)}
              title={action.title}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
