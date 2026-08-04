/**
 * `allowed-tools` is the capability grant on a built `SKILL.md`: a list of tool
 * patterns (`Bash(gh *)`, `Read`, `Write`) the skill may use. The human approves that
 * list on the plan-review screen, and the builder's *create* turn is an LLM call that
 * may return its own list — so the plan gate only means something if the submitted
 * list is provably **no wider** than the approved one.
 *
 * The builder's contract deliberately lets the agent *tighten* the grant to the steps
 * it actually emitted (approved `Bash(gh *)` → submitted `Bash(gh pr list)`). That
 * rules out a plain string comparison: set-membership would reject every narrowing and
 * silently fall back to the broader approved pattern, quietly disabling the one
 * behaviour the contract asks for. So this module decides **pattern subsumption**:
 * does the submitted pattern grant anything the approved pattern does not?
 *
 * Everything here is pure and deterministic so the trust boundary is unit-testable in
 * isolation, and it errs toward refusal: anything unparseable, ambiguous, or not
 * provably covered is treated as *not* covered.
 */

/** A parsed `allowed-tools` entry. `arg === null` means the bare, unrestricted form. */
export interface ToolPattern {
  tool: string;
  arg: string | null;
}

/**
 * Split `Tool(argument pattern)` / `Tool` into its parts, or null when the text is not
 * a usable grant. Only the outermost parentheses delimit, so a command may contain its
 * own — `Bash(echo (hi))` yields the argument `echo (hi)`.
 */
export function parseToolPattern(raw: string): ToolPattern | null {
  const text = raw.trim();
  if (!text) return null;

  const open = text.indexOf("(");
  if (open < 0) {
    // A bare name with a stray closing paren is malformed, not a grant.
    return text.includes(")") ? null : { tool: text, arg: null };
  }
  // The argument pattern must close at the very end; anything else is malformed.
  if (!text.endsWith(")")) return null;

  const tool = text.slice(0, open).trim();
  if (!tool) return null;
  return { tool, arg: text.slice(open + 1, -1).trim() };
}

/** Characters that must survive as literals when an argument pattern becomes a regex. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Stands in for the submitted pattern's own `*` while it is tested against the approved
 * pattern.
 *
 * It **must be a single character**. A multi-character sentinel can be partially matched
 * by an approved pattern whose literal segment happens to be a prefix of it — e.g. with
 * a `@@wildcard@@` sentinel, `Bash(a*)` would be reported as covered by `Bash(a@@w*)`,
 * because the `includes` guard below only catches the *whole* sentinel. That fails open,
 * which is the one direction this module must never fail in. A single character cannot
 * be partially matched: an approved literal segment either contains it (refused below)
 * or cannot touch it at all.
 *
 * U+E000 is in a Unicode private-use area, so no real tool pattern contains it. Built
 * from a code point rather than an escape so the source stays plain ASCII.
 */
const WILDCARD_SENTINEL = String.fromCodePoint(0xe000);

function escapeRegExp(text: string): string {
  return text.replace(REGEX_METACHARACTERS, "\\$&");
}

/** Compile an argument pattern, treating `*` as the only wildcard and the rest as literal. */
function argumentMatcher(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join("[\\s\\S]*");
  return new RegExp(`^${source}$`);
}

/**
 * True when every command `child` admits is also admitted by `parent`.
 *
 * `child`'s own wildcards become a sentinel before matching, so a `*` in `child` is only
 * covered where `parent` also has a `*` at that position: `gh pr *` ⊆ `gh *`, but
 * `*` ⊄ `gh *` — which is exactly the escalation to refuse.
 */
function argumentSubsumes(child: string, parent: string): boolean {
  if (child === parent) return true;
  // Refuse rather than reason about input that already contains the sentinel.
  if (child.includes(WILDCARD_SENTINEL) || parent.includes(WILDCARD_SENTINEL)) return false;
  return argumentMatcher(parent).test(child.split("*").join(WILDCARD_SENTINEL));
}

/**
 * True when `child` grants nothing beyond `parent` — i.e. `child` is a safe narrowing
 * (or an exact restatement) of the approved `parent`.
 *
 * Tool names compare case-insensitively: they are identifiers, and a case slip should
 * cost a valid narrowing rather than silently widen anything. Argument patterns stay
 * case-sensitive, because shell commands are (`GH` is not the `gh` CLI).
 */
export function isSubsumedBy(child: string, parent: string): boolean {
  const narrow = parseToolPattern(child);
  const broad = parseToolPattern(parent);
  if (!narrow || !broad) return false;
  if (narrow.tool.toLowerCase() !== broad.tool.toLowerCase()) return false;
  // A bare approved tool carries no argument restriction, so it covers any gated form.
  if (broad.arg === null) return true;
  // The reverse drops a restriction the human approved — a broadening.
  if (narrow.arg === null) return false;
  return argumentSubsumes(narrow.arg, broad.arg);
}

/**
 * A spelling-insensitive key for the same grant, so `Bash(gh *)` and `Bash( gh * )` do
 * not both reach the frontmatter. Mirrors the comparison rules in {@link isSubsumedBy}:
 * the tool name folds case, the argument pattern does not.
 */
function canonicalKey(pattern: ToolPattern): string {
  return pattern.arg === null
    ? pattern.tool.toLowerCase()
    : `${pattern.tool.toLowerCase()}(${pattern.arg})`;
}

export interface ConstrainedAllowedTools {
  /** The patterns to write into the skill's frontmatter. */
  allowed: string[];
  /** Submitted patterns refused because the approved plan does not cover them. */
  dropped: string[];
}

/**
 * Constrain an agent-submitted `allowed-tools` list to what the human actually approved.
 * Narrowing is kept, broadening is dropped and reported for logging.
 *
 * When nothing survives, this re-asserts the **approved** patterns instead of emitting
 * an empty list: an omitted `allowed-tools` means "use the agent's default set", which
 * may well be wider than what was approved — so an empty result would turn a refused
 * escalation into an unrestricted skill. An `approved` list that is itself empty is the
 * one case that stays empty: the human approved the default set, and no explicit pattern
 * can be proven narrower than a set whose contents we do not know.
 */
export function constrainAllowedTools(
  submitted: readonly string[],
  approved: readonly string[],
): ConstrainedAllowedTools {
  const approvedPatterns = approved.map((t) => t.trim()).filter(Boolean);
  const seen = new Set<string>();
  const allowed: string[] = [];
  const dropped: string[] = [];

  for (const raw of submitted) {
    const text = raw.trim();
    // A blank entry carries no grant, so it is neither kept nor worth reporting.
    if (!text) continue;
    const parsed = parseToolPattern(text);
    // Unparseable text has no canonical form; key it by its own spelling so it is still
    // reported once rather than silently collapsed with something else.
    const key = parsed ? canonicalKey(parsed) : text;
    if (seen.has(key)) continue;
    seen.add(key);
    if (approvedPatterns.some((pattern) => isSubsumedBy(text, pattern))) allowed.push(text);
    else dropped.push(text);
  }

  if (allowed.length === 0 && approvedPatterns.length > 0) {
    return { allowed: approvedPatterns, dropped };
  }
  return { allowed, dropped };
}
