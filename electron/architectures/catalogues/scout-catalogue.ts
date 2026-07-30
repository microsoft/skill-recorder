import { defineCatalogueProvider } from "../catalogue-provider";

/**
 * A **static, versioned** snapshot of the target agent's native capabilities,
 * embedded into the builder's system prompt. End users won't have the Scout repo
 * checked out, so we catalogue Scout's BUILT-IN tools and BUILT-IN (shipped)
 * skills here — authored by inspecting `~/projects/m` — and ship it as a constant.
 *
 * IMPORTANT: built-ins only. Do NOT list user-installed or repo-local skills; a
 * generated skill can only rely on what every Scout install ships with. Refresh
 * this when Scout's native tools/skills change.
 */
export const SCOUT_CATALOGUE_VERSION = "2026-07-26";

/**
 * The reusable core of the Scout catalogue: the native tools, built-in skills, and
 * recorded-action→capability mapping. Shared by the Skill Builder and the Automation
 * Builder (their preambles/tails differ, but both prefer these same capabilities).
 */
export const SCOUT_NATIVE_CAPABILITIES = `
## Where this runs, and the native tools to PREFER

Scout runs on the user's own **device — macOS or Windows**, not a sandbox: it has a real
shell and whatever command-line tools the user has installed (e.g. the \`gh\` GitHub CLI,
\`git\`, cloud CLIs). Prefer a real native tool, API, or first-class **CLI** over replaying
a web UI. Reach for these in order:

1. **WorkIQ (\`workiq_*\`) — Microsoft 365.** Use for anything in Teams, Outlook mail,
   Calendar, SharePoint/OneDrive, or the org directory. Read tools are auto-approved;
   send/create/update/delete need the user's approval at run time.
   - Teams / chat: \`workiq_search_chats\`, \`workiq_list_chats\`, \`workiq_get_chat\`,
     \`workiq_list_chat_messages\`, \`workiq_send_chat_message\`, \`workiq_reply_to_chat_message\`.
   - Email: \`workiq_search_emails\`, \`workiq_list_emails\`, \`workiq_get_email\`,
     \`workiq_send_email\`, \`workiq_create_draft\`, \`workiq_reply_to_email\`, \`workiq_forward_email\`.
   - Calendar: \`workiq_get_schedule\`, \`workiq_list_events\`, \`workiq_get_event\`,
     \`workiq_create_event\`, \`workiq_update_event\`, \`workiq_find_meeting_times\`, \`workiq_respond_to_event\`.
   - Files: \`workiq_search_files\`, \`workiq_list_files\`, \`workiq_get_recent_files\`,
     \`workiq_download_file\`, \`workiq_upload_file\`.
   - People: \`workiq_search_people\`, \`workiq_get_my_profile\`, \`workiq_get_my_manager\`,
     \`workiq_get_relevant_people\`.
2. **SDK built-ins — local files, code, and the web.** \`view\` (read a file), \`glob\`
   (find files by pattern), \`grep\` (search file contents), \`web_fetch\` (fetch a URL).
   These are how a skill DISCOVERS inputs on the local OS instead of asking the user.
3. **The device shell + installed CLIs (\`bash\`).** Scout runs on a real Mac or Windows
   machine, so when a service ships a first-class CLI, that CLI IS its native tool —
   prefer it over the browser. Above all: **GitHub → the \`gh\` CLI** (\`gh issue\`,
   \`gh pr\`, \`gh release\`, \`gh repo\`, \`gh api\`), already signed in on the device —
   never drive github.com through the browser. Likewise \`git\`, and the cloud/service
   CLIs the task used (\`az\`, \`aws\`, \`gcloud\`, \`kubectl\`, \`npm\`, \`docker\`). Write
   commands for the target OS — POSIX shell (zsh/bash) on **macOS**, **PowerShell** on
   **Windows** (mind path and quoting differences). Gate the shell with an
   \`allowed-tools\` pattern scoped to the tool, e.g. \`Bash(gh *)\` or \`Bash(git *)\`.
4. **Browser automation (\`browser_*\`, Playwright) — the UI fallback.** ONLY for a web app
   with no API and no CLI, that you must drive through its UI. (GitHub is NOT such a case —
   use \`gh\`.) Key tools: \`browser_navigate\`, \`browser_snapshot\` (always snapshot before
   you act — it returns the element refs), \`browser_click\`, \`browser_type\`,
   \`browser_fill_form\`, \`browser_select_option\`, \`browser_press_key\`, \`browser_wait_for\`,
   \`browser_take_screenshot\`.

## Built-in skills you can lean on

When the task matches one of Scout's shipped skills, USE it (write the body to invoke it)
instead of reinventing the procedure. Built-in skills:
- **pptx** — create, read, or edit PowerPoint (.pptx).
- **docx** — create, read, or edit Word (.docx).
- **xlsx** — create, read, or edit Excel/CSV (.xlsx, .csv).
- **loop** — edit Microsoft Loop documents in the browser.
- **web-artifacts-builder** — build self-contained interactive HTML apps/dashboards.
- **expense-report** — Dynamics 365 expense workflows (internal builds only).
- **excalidraw** — generate Excalidraw diagrams (internal builds only).

Assume ONLY the tools and skills listed above exist. Do not depend on any other
skill being installed.

## Recorded action → native capability (examples)

| Recording shows | Prefer |
| --- | --- |
| Searching / reading a Teams chat | \`workiq_search_chats\` → \`workiq_list_chat_messages\` |
| Reading / searching Outlook mail | \`workiq_search_emails\` / \`workiq_list_emails\` / \`workiq_get_email\` |
| Checking a calendar / free-busy | \`workiq_get_schedule\` / \`workiq_list_events\` |
| Sending a message, email, or invite | \`workiq_send_chat_message\` / \`workiq_send_email\` / \`workiq_create_event\` (approval) |
| Opening / reading a local file or folder | \`view\` / \`glob\` / \`grep\` |
| Reading a public web page | \`web_fetch\` |
| Acting on GitHub — issues, PRs, releases, repos, gists, Actions | the \`gh\` CLI via \`Bash(gh *)\` (\`gh issue\`, \`gh pr\`, \`gh release\`, \`gh api\`) — never the browser |
| Running git, cloud, or package operations | the matching CLI via the shell (\`git\`, \`az\`/\`aws\`/\`gcloud\`, \`npm\`, \`docker\`) |
| Editing a spreadsheet / doc / deck | the \`xlsx\` / \`docx\` / \`pptx\` built-in skill |
| Filling a form on a web app with no API or CLI | \`browser_navigate\` + \`browser_snapshot\` + \`browser_fill_form\`/\`browser_type\`/\`browser_click\` |
`.trim();

const SCOUT_CATALOGUE = `
# Target: Microsoft Scout — native capability catalogue (built-ins only)

A Scout **skill** is a \`SKILL.md\` file: optional YAML frontmatter followed by a
markdown **instructions body**. Scout auto-loads user skills from
\`~/.copilot/skills/<name>/SKILL.md\`.

Frontmatter fields:
- \`name\` — kebab-case, \`^[a-z0-9-]+$\`.
- \`description\` — one line of trigger keywords (when Scout should reach for this skill).
- \`allowed-tools\` (optional) — a YAML list of tool patterns the skill may use, e.g.
  \`Bash(git *)\`, \`Read\`, \`Write\`, \`Grep\`, \`Glob\`. Omit it to allow the default set.

The body is plain instructions written TO the Scout agent (imperative voice): when
to use the skill, the procedure to follow, and how to handle inputs and edge cases.

${SCOUT_NATIVE_CAPABILITIES}

## Writing the SKILL.md body

- Write a GENERALIZED procedure: if the recording acted on N specific items, the body
  loops over ALL items of that kind, not the specific examples that were recorded.
- Resolve each input via the plan (a fixed value / the user provides it / the agent locates it on the device).
- Prefer the native tools above; only use the browser for genuine UI-only steps.
- Keep it concise and imperative. Include a short "When to use" and the ordered steps.
`.trim();

/**
 * The Automation Builder's Scout catalogue. Reuses the shared native-capability
 * snapshot ({@link SCOUT_NATIVE_CAPABILITIES}) but frames it for **automations** —
 * a scheduled/condition trigger plus ordered steps, where each step is a
 * natural-language **prompt** to the Scout agent (not a `SKILL.md` procedure).
 * Authored by inspecting `~/projects/m` (electron/automations/*). Refresh when
 * Scout's automation model or native tools change.
 */
export const SCOUT_AUTOMATION_CATALOGUE_VERSION = "2026-07-26";

const SCOUT_AUTOMATION_CATALOGUE = `
# Target: Microsoft Scout — automation catalogue (built-ins only)

A Scout **automation** is a **trigger** plus an ordered list of **steps**. Scout runs
the steps in order on the trigger; each step is a natural-language **prompt** the Scout
agent executes with its native tools (below). Automations are imported into Scout from a
bundle folder — they are NOT auto-loaded like skills.

## Trigger

- **schedule** (default) — the automation runs on a clock. Express it as natural language
  such as: "every weekday at 9am", "daily at 8:30am", "every day at 9am, 2pm, and 6pm",
  "every 30 minutes", or "every hour at :15". The three shapes are:
  - **single** — one time of day (optionally only on some weekdays).
  - **interval** — every N minutes (N must divide 1440 evenly), from an anchor time.
  - **multi** — several fixed times of day.
- **condition** — the automation checks a natural-language condition on a cadence and only
  runs when it's true (e.g. "when a new CSV appears in ~/Downloads"). Use this only when the
  recording clearly implies an event trigger; otherwise prefer a schedule.

A recording captures ONE run of the task and usually has NO "when to run" signal — so you
must PROPOSE a sensible default schedule (state your assumption) and let the user correct it
in plain language.

## Steps — each is a prompt

- Break the generalized task into a few ordered steps. Each step has a short **label** and a
  **prompt** — an imperative instruction to the Scout agent for that part of the task.
- Write prompts that GENERALIZE: if the recording acted on N specific items, the prompt tells
  the agent to handle every item of that kind, not the specific examples recorded.
- Prompts should prefer Scout's native tools (below) over UI replay, and say briefly why.
- Self-resolving prompts: reference a genuinely fixed literal by its \`{{id}}\` value token,
  and for anything that varies tell the agent to locate it on the device or read it from M365.
  An unattended automation can't stop to ask a human, so never depend on a user-provided value.
- Keep destructive or send/create actions explicit so the user sees them in the plan.

${SCOUT_NATIVE_CAPABILITIES}

## Writing the automation

- Propose a trigger (a schedule by default) and 2–6 generalized, native-tool-first steps.
- Prefer the native tools above; use the device's CLI (e.g. \`gh\` for GitHub) over the
  browser, and only use the browser for genuine UI-only steps (no API and no CLI).
- Give the automation a clear \`description\` of what it does and when it runs.
`.trim();

export default defineCatalogueProvider({
  architecture: "scout",
  skill: {
    version: SCOUT_CATALOGUE_VERSION,
    content: SCOUT_CATALOGUE,
  },
  automation: {
    version: SCOUT_AUTOMATION_CATALOGUE_VERSION,
    content: SCOUT_AUTOMATION_CATALOGUE,
  },
});
