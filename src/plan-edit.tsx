import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { AnalysisStep } from "../common/analysis";
import {
  describeSchedule,
  type AutomationSchedule,
  type AutomationStepDraft,
  type TimeOfDay,
} from "../common/automation";
import type { PlanStep } from "../common/skill";
import { planToolLabel } from "../common/plan-tools";
import { tokenize, type Value } from "../common/values";

/* --- shared array helpers (pure) ----------------------------------------- */

export function replaceAt<T>(arr: T[], i: number, next: T): T[] {
  const out = arr.slice();
  out[i] = next;
  return out;
}
export function removeAt<T>(arr: T[], i: number): T[] {
  return arr.filter((_, idx) => idx !== i);
}
export function moveItem<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const out = arr.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/* --- EditableText: reads as plain text, becomes an input on click --------- */

export function EditableText({
  value,
  onChange,
  placeholder = "",
  multiline = false,
  as = "span",
  className = "",
  rows = 2,
  hideEmpty = false,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  as?: "span" | "div" | "p";
  className?: string;
  rows?: number;
  /** When empty, stay invisible until the surrounding tile is hovered. */
  hideEmpty?: boolean;
  ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [editing]);

  const begin = () => {
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (draft !== value) onChange(draft);
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    const shared = {
      value: draft,
      "aria-label": ariaLabel ?? placeholder,
      onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      onBlur: commit,
    };
    return multiline ? (
      <textarea
        ref={ref as React.Ref<HTMLTextAreaElement>}
        className={`ed-input ed-input-multi ${className}`}
        rows={rows}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
        {...shared}
      />
    ) : (
      <input
        ref={ref as React.Ref<HTMLInputElement>}
        className={`ed-input ${className}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        {...shared}
      />
    );
  }

  const empty = value.trim().length === 0;
  const Tag = as;
  return (
    <Tag
      className={`ed-read ${multiline ? "ed-read-multi" : ""} ${empty ? "ed-empty" : ""} ${
        empty && hideEmpty ? "ed-hide" : ""
      } ${className}`}
      tabIndex={0}
      role="textbox"
      aria-label={ariaLabel ?? placeholder}
      title="Click to edit"
      onClick={begin}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          begin();
        }
      }}
    >
      {empty ? placeholder : value}
    </Tag>
  );
}

/* --- reusable row controls (hover-revealed by CSS) ----------------------- */

function RowControls({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  /** Omit to hide reorder arrows (e.g. for an unordered set). */
  onMove?: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="row-controls">
      {onMove && (
        <>
          <button
            type="button"
            className="tile-btn"
            title="Move up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="tile-btn"
            title="Move down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </>
      )}
      <button type="button" className="tile-btn tile-btn-del" title="Remove" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function AddTile({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <button type="button" className="tile-add" onClick={onAdd}>
      + {label}
    </button>
  );
}

let uidCounter = 0;
function newId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

/* --- Value pills: a {{token}} rendered as a named, inline-editable chip ---- */

/** Size a textarea to its content so a long value (e.g. a URL) is fully visible. */
function autoGrowTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** One `{{id}}` reference. Shows the value's human name as an inline chip; clicking opens a
 *  small popover (portaled, anchored to the chip) with the value's name as a label and a
 *  full-width, auto-growing field for the literal that substitutes in at export. Open state
 *  is controlled by the parent so only one popover is ever open — even when the same token
 *  appears more than once in a step. An unknown token (no matching value) renders as a
 *  flagged, non-editable chip so it's caught before shipping. */
function ValuePill({
  token,
  value,
  open,
  onOpen,
  onClose,
  onChange,
}: {
  token: string;
  value: Value | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (next: Value) => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // Unknown token: no value to edit — flag it so the user (or agent) fixes it before export.
  if (!value) {
    return (
      <span className="val-pill val-pill-unresolved" title="No value is defined for this token">
        {`{{${token}}}`}
      </span>
    );
  }

  const label = value.name || token;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`val-pill${value.value.trim() ? "" : " val-pill-empty"}${open ? " val-pill-active" : ""}`}
        title={`${label}${value.value ? `: ${value.value}` : ""} — click to edit`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        {label}
      </button>
      {open && (
        <ValuePopover
          anchorRef={btnRef}
          label={label}
          value={value.value}
          onCommit={(next) => {
            onClose();
            if (next !== value.value) onChange({ ...value, value: next });
          }}
          onCancel={onClose}
        />
      )}
    </>
  );
}

/** A small floating editor for one value's literal, anchored under its pill and portaled to
 *  <body> so scroll/overflow containers can't clip it. The sentence layout stays put while
 *  the card floats above. Commits on Enter or click-outside; Escape cancels. */
function ValuePopover({
  anchorRef,
  label,
  value,
  onCommit,
  onCancel,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  label: string;
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(value);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;
    const a = anchor.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const m = 8; // viewport margin
    const left = Math.max(m, Math.min(a.left, window.innerWidth - cw - m));
    let top = a.bottom + 6;
    if (top + ch > window.innerHeight - m) {
      const above = a.top - ch - 6;
      top = above >= m ? above : Math.max(m, window.innerHeight - ch - m);
    }
    setPos({ top, left });
  }, [anchorRef]);

  // Focus the field and grow it to fit the value on open.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autoGrowTextarea(el);
  }, []);

  // Position after layout, and re-measure as the field grows.
  useLayoutEffect(() => {
    reposition();
  }, [reposition, draft]);

  // Stay anchored on scroll/resize; commit when the user clicks outside the card.
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => {
    const onScroll = () => reposition();
    const onDocPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      commitRef.current(taRef.current?.value ?? "");
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    document.addEventListener("mousedown", onDocPointer, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("mousedown", onDocPointer, true);
    };
  }, [reposition, anchorRef]);

  return createPortal(
    <div
      ref={cardRef}
      className="val-pop"
      role="dialog"
      aria-label={`Edit ${label}`}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
      // The card is portaled to <body>, but React bubbles its synthetic events through the
      // component tree — so without this, a click inside would reach the step's read-mode
      // <p onClick> and switch it into the prose editor, unmounting this popover.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="val-pop-label">{label}</div>
      <textarea
        ref={taRef}
        className="val-pop-input"
        rows={1}
        value={draft}
        spellCheck={false}
        aria-label={`${label} value`}
        onChange={(e) => {
          setDraft(e.target.value);
          autoGrowTextarea(e.target);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit(draft);
          }
        }}
      />
      <div className="val-pop-hint">Esc to cancel · ⏎ to save</div>
    </div>,
    document.body,
  );
}

/** Serialize the pill editor's DOM back to `{{id}}` template text: text nodes are kept
 *  verbatim and each atomic pill chip (a `[data-token]` element) becomes its `{{id}}`, so
 *  the round-trip is exact and the raw token is never typed by the user. */
function serializeTokenNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tok = el.dataset.token;
  if (tok) return `{{${tok}}}`;
  if (el.tagName === "BR") return "\n";
  let out = "";
  el.childNodes.forEach((c) => (out += serializeTokenNode(c)));
  return out;
}

function serializeTokenEditor(root: HTMLElement): string {
  let out = "";
  root.childNodes.forEach((c) => (out += serializeTokenNode(c)));
  return out;
}

/** Populate the pill editor: prose becomes editable text nodes, and each `{{id}}` becomes
 *  an atomic, non-editable chip that looks exactly like its read-mode pill — so editing the
 *  wording around a value never exposes the raw `{{token}}`. */
function buildTokenEditor(root: HTMLElement, text: string, values: Value[]): void {
  const byId = new Map(values.map((v) => [v.id, v]));
  root.replaceChildren();
  for (const seg of tokenize(text)) {
    if (seg.kind === "text") {
      root.appendChild(document.createTextNode(seg.text));
      continue;
    }
    const v = byId.get(seg.id);
    const chip = document.createElement("span");
    chip.dataset.token = seg.id;
    chip.contentEditable = "false";
    if (!v) {
      chip.className = "val-pill val-pill-unresolved";
      chip.textContent = `{{${seg.id}}}`;
    } else {
      chip.className = `val-pill${v.value.trim() ? "" : " val-pill-empty"}`;
      chip.textContent = v.name || seg.id;
    }
    root.appendChild(chip);
  }
}

/** Step body that renders `{{id}}` tokens as editable {@link ValuePill}s. In read mode a
 *  pill shows the value's name and click-edits its literal; clicking the prose opens an
 *  inline editor where pills stay atomic chips (never raw tokens) and only the surrounding
 *  wording is editable. Editing prose updates the step text; editing a pill updates the
 *  shared value. */
function TokenText({
  text,
  onChangeText,
  values,
  onChangeValues,
  placeholder,
  ariaLabel,
}: {
  text: string;
  onChangeText: (next: string) => void;
  values: Value[];
  onChangeValues: (next: Value[]) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef(false);
  // Index (into `segments`) of the token whose editor popover is open, or null. Kept here so
  // at most one popover is ever open — even when a token appears more than once in the step.
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!editing) return;
    const el = editorRef.current;
    if (!el) return;
    // Snapshot the current text/values into the editor once; it stays uncontrolled while
    // focused so keystrokes and the caret aren't clobbered by re-renders.
    buildTokenEditor(el, text, values);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const begin = () => {
    setOpenIndex(null);
    setEditing(true);
  };
  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setEditing(false);
      return;
    }
    const el = editorRef.current;
    const next = el ? serializeTokenEditor(el) : text;
    setEditing(false);
    if (next !== text) onChangeText(next);
  };
  const updateValue = (next: Value) =>
    onChangeValues(values.map((v) => (v.id === next.id ? next : v)));

  if (editing) {
    return (
      <div
        ref={editorRef}
        className="ed-input ed-input-multi ed-detail token-edit has-pills"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        onBlur={commit}
        onMouseDown={(e) => {
          // Clicking a pill chip inside the editor edits that value (not the prose): commit
          // the wording, then open that token's popover (first occurrence) in read mode.
          const chip = (e.target as HTMLElement).closest("[data-token]") as HTMLElement | null;
          if (!chip) return;
          e.preventDefault();
          const id = chip.dataset.token ?? null;
          const el = editorRef.current;
          const next = el ? serializeTokenEditor(el) : text;
          cancelRef.current = true; // neutralize the blur-commit that unmounting would fire
          setEditing(false);
          if (next !== text) onChangeText(next);
          if (id) {
            const idx = tokenize(next).findIndex((s) => s.kind === "token" && s.id === id);
            if (idx >= 0) setOpenIndex(idx);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancelRef.current = true;
            editorRef.current?.blur();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            editorRef.current?.blur();
          }
        }}
      />
    );
  }

  const empty = text.trim().length === 0;
  const segments = empty ? [] : tokenize(text);
  const byId = new Map(values.map((v) => [v.id, v]));

  return (
    <p
      className={`ed-read ed-read-multi ed-detail${empty ? " ed-empty" : " has-pills"}`}
      tabIndex={0}
      role="textbox"
      aria-label={ariaLabel}
      title="Click to edit"
      onClick={(e) => {
        // A click on a pill edits its value (via popover), not the surrounding prose.
        const t = e.target as HTMLElement;
        if (t.closest(".val-pill")) return;
        begin();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          begin();
        }
      }}
    >
      {empty
        ? placeholder
        : segments.map((seg, i) =>
            seg.kind === "token" ? (
              <ValuePill
                key={i}
                token={seg.id}
                value={byId.get(seg.id)}
                open={openIndex === i}
                onOpen={() => setOpenIndex(i)}
                onClose={() => setOpenIndex(null)}
                onChange={updateValue}
              />
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
    </p>
  );
}

/* --- Skill steps (ordered; numbered title + description) ------------------ */

export function SkillStepTiles({
  steps,
  onChange,
  values,
  onChangeValues,
}: {
  steps: PlanStep[];
  onChange: (next: PlanStep[]) => void;
  values: Value[];
  onChangeValues: (next: Value[]) => void;
}) {
  const patch = (i: number, part: Partial<PlanStep>) =>
    onChange(replaceAt(steps, i, { ...steps[i], ...part }));

  return (
    <div className="tiles">
      {steps.map((s, i) => (
        <div key={i} className="tile step-tile">
          <div className="tile-head">
            <span className="tile-num">{i + 1}</span>
            <EditableText
              className="ed-strong"
              value={s.title}
              placeholder="Step title"
              ariaLabel="Step title"
              onChange={(v) => patch(i, { title: v })}
            />
            <RowControls
              index={i}
              count={steps.length}
              onMove={(dir) => onChange(moveItem(steps, i, dir))}
              onRemove={() => onChange(removeAt(steps, i))}
            />
          </div>
          <TokenText
            text={s.text}
            onChangeText={(v) => patch(i, { text: v })}
            values={values}
            onChangeValues={onChangeValues}
            placeholder="What happens in this step?"
            ariaLabel="Step description"
          />
          {s.tools.length > 0 && (
            <div className="tile-foot">
              {s.tools.map((tool) => (
                <span className="step-tool" title={`Runtime tool: ${tool}`} key={tool}>
                  {planToolLabel(tool)}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      <AddTile
        label="Add step"
        onAdd={() => onChange([...steps, { kind: "action", title: "", text: "", tools: [] }])}
      />
    </div>
  );
}

/* --- Automation steps (ordered; label + NL prompt) ------------------------ */

export function AutomationStepTiles({
  steps,
  onChange,
  values,
  onChangeValues,
}: {
  steps: AutomationStepDraft[];
  onChange: (next: AutomationStepDraft[]) => void;
  values: Value[];
  onChangeValues: (next: Value[]) => void;
}) {
  const patch = (i: number, part: Partial<AutomationStepDraft>) =>
    onChange(replaceAt(steps, i, { ...steps[i], ...part }));

  return (
    <div className="tiles">
      {steps.map((s, i) => (
        <div key={i} className="tile step-tile">
          <div className="tile-head">
            <span className="tile-num">{i + 1}</span>
            <EditableText
              className="ed-strong"
              value={s.label}
              placeholder="Step label"
              ariaLabel="Step label"
              onChange={(v) => patch(i, { label: v })}
            />
            <RowControls
              index={i}
              count={steps.length}
              onMove={(dir) => onChange(moveItem(steps, i, dir))}
              onRemove={() => onChange(removeAt(steps, i))}
            />
          </div>
          <TokenText
            text={s.prompt}
            onChangeText={(v) => patch(i, { prompt: v })}
            values={values}
            onChangeValues={onChangeValues}
            placeholder="The instruction the agent runs for this step"
            ariaLabel="Step instruction"
          />
        </div>
      ))}
      <AddTile label="Add step" onAdd={() => onChange([...steps, { label: "", prompt: "" }])} />
    </div>
  );
}

/* --- Analysis steps (ordered; title + detail) ----------------------------- */

export function AnalysisStepTiles({
  steps,
  onChange,
}: {
  steps: AnalysisStep[];
  onChange: (next: AnalysisStep[]) => void;
}) {
  const patch = (i: number, part: Partial<AnalysisStep>) =>
    onChange(replaceAt(steps, i, { ...steps[i], ...part }));

  return (
    <div className="tiles">
      {steps.map((s, i) => (
        <div key={s.id} className="tile step-tile">
          <div className="tile-head">
            <span className="tile-num">{i + 1}</span>
            <EditableText
              className="ed-strong"
              value={s.title}
              placeholder="What you did"
              ariaLabel="Step title"
              onChange={(v) => patch(i, { title: v })}
            />
            <RowControls
              index={i}
              count={steps.length}
              onMove={(dir) => onChange(moveItem(steps, i, dir))}
              onRemove={() => onChange(removeAt(steps, i))}
            />
          </div>
          <EditableText
            as="p"
            multiline
            className="ed-detail"
            value={s.detail}
            placeholder="A little more detail"
            ariaLabel="Step detail"
            hideEmpty
            onChange={(v) => patch(i, { detail: v })}
          />
        </div>
      ))}
      <AddTile
        label="Add step"
        onAdd={() =>
          onChange([
            ...steps,
            { id: newId("u"), title: "", detail: "", apps: [], evidence: [], confidence: "medium" },
          ])
        }
      />
    </div>
  );
}

/* --- Automation schedule editor (read-first: sentence → controls) --------- */

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const INTERVAL_CHOICES = [15, 30, 60, 120, 180, 240, 360, 720];

function fmtTime(t: TimeOfDay): string {
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}
function parseTime(v: string): TimeOfDay {
  const [h, m] = v.split(":").map((n) => Number.parseInt(n, 10));
  return { hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 };
}
function anchorOf(s: AutomationSchedule): TimeOfDay {
  if (s.kind === "single") return s.time;
  if (s.kind === "interval") return s.anchor;
  return s.times[0] ?? { hour: 9, minute: 0 };
}

/** Compact schedule editor. Reads as a plain-language sentence; "Edit" reveals the
 *  structured controls. Structured edits clear `naturalLanguage` so the displayed
 *  cadence always reflects the real firing rule. */
export function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: AutomationSchedule;
  onChange: (next: AutomationSchedule) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <div className="sched-read">
        <span className="sched-when">{describeSchedule(schedule)}</span>
        <button type="button" className="linky" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
    );
  }

  const days = schedule.days;
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
    onChange({ ...schedule, days: next, naturalLanguage: "" });
  };

  const changeKind = (kind: AutomationSchedule["kind"]) => {
    if (kind === schedule.kind) return;
    const anchor = anchorOf(schedule);
    if (kind === "single") onChange({ kind: "single", naturalLanguage: "", days, time: anchor });
    else if (kind === "interval")
      onChange({ kind: "interval", naturalLanguage: "", days, intervalMinutes: 60, anchor });
    else onChange({ kind: "multi", naturalLanguage: "", days, times: [anchor] });
  };

  return (
    <div className="sched-edit">
      <div className="sched-row">
        <select
          className="tile-select"
          value={schedule.kind}
          onChange={(e) => changeKind(e.target.value as AutomationSchedule["kind"])}
        >
          <option value="single">Once a day</option>
          <option value="interval">Every…</option>
          <option value="multi">A few times a day</option>
        </select>

        {schedule.kind === "single" && (
          <input
            type="time"
            className="tile-input tile-time"
            value={fmtTime(schedule.time)}
            onChange={(e) => onChange({ ...schedule, time: parseTime(e.target.value), naturalLanguage: "" })}
          />
        )}

        {schedule.kind === "interval" && (
          <>
            <select
              className="tile-select"
              value={schedule.intervalMinutes}
              onChange={(e) =>
                onChange({ ...schedule, intervalMinutes: Number.parseInt(e.target.value, 10), naturalLanguage: "" })
              }
            >
              {INTERVAL_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60} h`}
                </option>
              ))}
            </select>
            <span className="sched-lbl">from</span>
            <input
              type="time"
              className="tile-input tile-time"
              value={fmtTime(schedule.anchor)}
              onChange={(e) => onChange({ ...schedule, anchor: parseTime(e.target.value), naturalLanguage: "" })}
            />
          </>
        )}

        <button type="button" className="linky sched-done" onClick={() => setEditing(false)}>
          Done
        </button>
      </div>

      {schedule.kind === "multi" && (
        <div className="sched-times">
          {schedule.times.map((t, i) => (
            <div key={i} className="sched-time-row">
              <input
                type="time"
                className="tile-input tile-time"
                value={fmtTime(t)}
                onChange={(e) =>
                  onChange({ ...schedule, times: replaceAt(schedule.times, i, parseTime(e.target.value)), naturalLanguage: "" })
                }
              />
              <button
                type="button"
                className="tile-btn tile-btn-del"
                title="Remove time"
                disabled={schedule.times.length <= 1}
                onClick={() => onChange({ ...schedule, times: removeAt(schedule.times, i), naturalLanguage: "" })}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="tile-add"
            onClick={() =>
              onChange({ ...schedule, times: [...schedule.times, anchorOf(schedule)], naturalLanguage: "" })
            }
          >
            + Add time
          </button>
        </div>
      )}

      <div className="sched-days">
        <span className="sched-lbl">On</span>
        {DAY_LABELS.map((lbl, d) => (
          <button
            key={d}
            type="button"
            className={`day-chip${days.length === 0 || days.includes(d) ? " on" : ""}`}
            title={days.length === 0 ? "Every day" : undefined}
            onClick={() => toggleDay(d)}
          >
            {lbl}
          </button>
        ))}
        {days.length === 0 && <span className="sched-lbl sched-every">every day</span>}
      </div>
    </div>
  );
}
