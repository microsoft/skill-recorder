/**
 * A **static, versioned** snapshot of the "generic agent" target's capabilities —
 * unlike {@link ../skillbuilder/scout-catalog.ts} and {@link ../skillbuilder/cowork-catalog.ts},
 * this is deliberately NOT a catalogue of one product's internal tool IDs. It exists so a
 * recording can be turned into a portable `SKILL.md` that doesn't assume the destination
 * agent has `workiq_*`, `m365_*`, or any other product-specific tool — only the common-
 * denominator primitives most coding/ops agents ship with (a shell, file read/write/search,
 * and HTTP fetch).
 *
 * IMPORTANT: no product-specific tool names here, ever. If a future primitive is added,
 * it must be something broadly available across agents (not one vendor's API), or it
 * belongs in a product-specific catalogue instead.
 */
export const GENERIC_CATALOGUE_VERSION = "2026-08-03";

/**
 * The reusable core of the generic catalogue: universal primitives and a recorded-action→
 * primitive mapping, with no reference to any single agent's internal tool IDs.
 */
export const GENERIC_NATIVE_CAPABILITIES = `
## Where this runs, and what to assume

The destination agent is UNKNOWN — it could be Claude Code, Copilot CLI, or any other
coding/ops agent. Do not assume any product-specific tool exists. Only rely on the
common-denominator primitives every such agent has in some form:

1. **A shell.** The agent can run shell commands and whatever CLIs the user has installed
   (\`git\`, \`gh\`, \`az\`/\`aws\`/\`gcloud\`, \`npm\`, \`docker\`, etc.). Prefer a first-class CLI or
   API over driving a web UI. Describe commands in plain POSIX shell; call out where a
   Windows/PowerShell equivalent would differ if the task is platform-sensitive.
2. **Local file read / write / search.** The agent can read a file, write or edit a file,
   search file contents, and find files by name/pattern. Describe these as plain actions
   ("read <file>", "search <dir> for <pattern>") rather than naming a specific tool call.
3. **HTTP fetch.** The agent can fetch a URL's contents. Use this for reading public pages
   or calling a documented HTTP API — describe it as "fetch <url>", not a named tool.
4. **Browser UI automation — LAST RESORT, and never assumed.** Some agents can drive a web
   UI (click, type, navigate); many cannot. Only fall back to a UI-driven step when the task
   has no API and no CLI, and explicitly flag it as "requires browser automation, if the
   agent supports it" so the skill degrades gracefully (skip/ask the user) on an agent that
   doesn't.

Do NOT reference: \`workiq_*\`, \`m365_*\`/\`outlook*\`/\`sharepoint*\`, \`pbi_*\`, named
\`browser_*\` tool suites, or any other vendor-specific tool ID. If the recording used one of
those (e.g. it recorded a Teams or SharePoint action), translate it to the closest universal
primitive above (an API/CLI call if one exists, otherwise a flagged manual/UI step) rather
than naming the product tool that happened to be recorded.

## Recorded action → universal primitive (examples)

| Recording shows | Prefer |
| --- | --- |
| Opening / reading a local file or folder | plain file read / directory listing |
| Editing or creating a local file | plain file write/edit |
| Searching file contents or finding files by name | plain content search / filename search |
| Reading a public web page or calling a documented API | HTTP fetch of the URL/endpoint |
| Acting on GitHub — issues, PRs, releases, repos | the \`gh\` CLI via the shell (\`gh issue\`, \`gh pr\`, \`gh api\`) |
| Running git, cloud, or package operations | the matching CLI via the shell (\`git\`, \`az\`/\`aws\`/\`gcloud\`, \`npm\`, \`docker\`) |
| Acting inside Teams, Outlook, SharePoint, or another product-specific surface | no universal primitive covers this — call it out as "requires <product>'s own tool/API on the destination agent" rather than naming the recorded tool |
| Filling a form on a web app with no API or CLI | flag as a browser-automation step, "if the agent supports it" — do not assume it does |
`.trim();

const GENERIC_CATALOGUE = `
# Target: Generic agent — portable, tool-agnostic capability catalogue

A generic-target **skill** is a \`SKILL.md\` file: YAML frontmatter followed by a markdown
**instructions body**, written so it can be dropped into any agent's skills directory
without edits.

Frontmatter fields:
- \`name\` — kebab-case, \`^[a-z0-9-]+$\`.
- \`description\` — one line of trigger keywords (when an agent should reach for this skill).
- \`allowed-tools\` (optional) — a YAML list of broadly-recognized permission-scoping patterns,
  e.g. \`Bash(git *)\`, \`Read\`, \`Write\`, \`Grep\`, \`Glob\`. These names are conventional across
  several agents; an agent that doesn't recognize \`allowed-tools\` simply ignores it, so it's
  safe to include but never required for the skill to be understood.

The body is plain instructions written TO whichever agent loads it (imperative voice): when
to use the skill, the procedure to follow, and how to handle inputs and edge cases — using
only the universal primitives below, never a named product tool.

${GENERIC_NATIVE_CAPABILITIES}

## Writing the SKILL.md body

- Write a GENERALIZED procedure: if the recording acted on N specific items, the body loops
  over ALL items of that kind, not the specific examples that were recorded.
- Resolve each input via the plan (a fixed value / the user provides it / the agent locates it).
- Describe every step in plain imperative language using only the universal primitives above
  — no \`workiq_*\`, no \`m365_*\`, no named browser-tool suite, no other vendor-specific tool ID.
- If a recorded step has no universal-primitive equivalent (e.g. a Teams/SharePoint/Outlook
  action), say so explicitly in the body rather than inventing or naming a tool for it.
- Keep it concise and imperative. Include a short "When to use" and the ordered steps.
`.trim();

/** The generic catalogue. Exposed so {@link catalogueFor} can dispatch on it. */
export function genericCatalogue(): string {
  return GENERIC_CATALOGUE;
}
