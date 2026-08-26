import { defineCatalogueProvider } from "../catalogue-provider";

/**
 * A **static, versioned** snapshot of the Cowork (Microsoft 365 Copilot) agent's native
 * capabilities, embedded into the builder's system prompt. End users won't have the Cowork
 * harness introspectable, so we catalogue its BUILT-IN tools, MCP tools, and BUILT-IN
 * (shipped) skills here — authored from the agent-harness capability report — and ship it as
 * a constant.
 *
 * IMPORTANT: built-ins only. Do NOT list user-installed skills; a generated skill can only
 * rely on what every Cowork install ships with. Refresh this when Cowork's native
 * tools/skills change (re-run the harness capability report and diff).
 */
export const COWORK_CATALOGUE_VERSION = "2026-07-28";

/**
 * The reusable core of the Cowork catalogue: the native tools, built-in skills, and
 * recorded-action→capability mapping. Kept exported for symmetry with the Scout catalogue
 * (and any future Cowork automation support), though only the Skill Builder uses it today.
 */
export const COWORK_NATIVE_CAPABILITIES = `
## Where this runs, and the native tools to PREFER

Cowork is a **Microsoft 365 Copilot** agent with first-class **Microsoft 365** tools plus a
real shell and local file tools. Prefer a real native tool, API, or first-class **CLI** over
replaying a web UI. Reach for these in order:

1. **Microsoft 365 (MCP tools).** Use for anything in Teams, Outlook mail, Calendar,
   SharePoint/OneDrive, the org directory, or unified M365 search. Read tools are
   auto-approved; send/create/update/delete need the user's approval at run time.
   - Teams / chat: \`m365_teams/ListChats\`, \`m365_teams/GetChat\`, \`m365_teams/ListChatMessages\`,
     \`m365_teams/PostMessage\`, \`m365_teams/CreateChat\`, \`m365_teams/ListChannels\`,
     \`m365_teams/ListChannelMessages\`, \`m365_teams/PostChannelMessage\`, \`m365_teams/ReplyToChannelMessage\`.
   - Email: \`outlook/ListMessages\`, \`outlook/GetMessage\`, \`outlook/CreateDraftMessage\`,
     \`outlook/SendDraftMessage\`, \`outlook/ReplyToMessage\`, \`outlook/ReplyAllToMessage\`,
     \`outlook/ForwardMessage\`, \`outlook/SendEmailWithAttachments\`, \`outlook/ListMailFolders\`, \`outlook/MoveMessage\`.
   - Calendar: \`outlook_calendar/ListEvents\`, \`outlook_calendar/ListCalendarView\`,
     \`outlook_calendar/CreateEvent\`, \`outlook_calendar/UpdateEvent\`, \`outlook_calendar/FindMeetingTimes\`,
     \`outlook_calendar/GetRooms\`, \`outlook_calendar/AcceptEvent\`, \`outlook_calendar/DeclineEvent\`.
   - Files: \`sharepoint_onedrive/SearchDrive\`, \`sharepoint_onedrive/GetDriveChildren\`,
     \`sharepoint_onedrive/GetDriveItem\`, \`sharepoint_onedrive/ReadFileContent\`,
     \`sharepoint_onedrive/CreateFolder\`, \`sharepoint_onedrive/ListMyDrives\`, \`sharepoint_onedrive/SearchSites\`.
   - People / org: \`me_profile/GetMyDetails\`, \`me_profile/SearchPeople\`, \`me_profile/GetUserDetails\`,
     \`me_profile/GetManagerDetails\`, \`me_profile/GetDirectReportsDetails\`, \`me_profile/GetOrgTree\`.
   - Unified search: \`m365_search/SearchM365\` (across mail, files, chats, people).
   - Meeting transcripts: \`graph/GetMyRecentTranscripts\`, \`graph/ListMeetingTranscripts\`,
     \`graph/GetMeetingTranscript\`.
   - Escape hatch: \`graph/QueryGraph\` / \`graph/CallGraph\` for any Microsoft Graph call not
     covered by a dedicated tool above.
2. **SDK built-ins — local files and the web.** \`Read\` (read a file), \`Glob\` (find files by
   pattern), \`Grep\` (search file contents), \`core/web_fetch\` (fetch a URL), \`core/web_search\`
   (search the web). These DISCOVER inputs on the local OS or the public web instead of asking
   the user. Use \`Write\` / \`Edit\` to author or update local files.
3. **The device shell + installed CLIs (\`Bash\`).** When a service ships a first-class CLI, that
   CLI IS its native tool — prefer it over the browser. Above all: **GitHub → the \`gh\` CLI**
   (\`gh issue\`, \`gh pr\`, \`gh release\`, \`gh repo\`, \`gh api\`) — never drive github.com through a
   browser. Likewise \`git\`, and the cloud/service CLIs the task used (\`az\`, \`aws\`, \`gcloud\`,
   \`kubectl\`, \`npm\`, \`docker\`). Gate the shell with an \`allowed-tools\` pattern scoped to the
   tool, e.g. \`Bash(gh *)\` or \`Bash(git *)\`.
4. **Power BI (\`pbi_fabricaihub/*\`).** For Power BI / Fabric reports and semantic models:
   \`pbi_fabricaihub/ResolveReportIdFromUrl\`, \`pbi_fabricaihub/GetReportMetadata\`,
   \`pbi_fabricaihub/GetSemanticModelSchema\`, \`pbi_fabricaihub/ExecuteQuery\`, \`pbi_fabricaihub/ValueSearch\`.

> **No browser automation.** Cowork has NO Playwright / \`browser_*\` tools — it cannot click or
> type in a web UI. For a web app with no API and no CLI, the most it can do is READ a public
> page with \`core/web_fetch\`. So map every recorded UI step to an M365 tool, a CLI, or an API;
> if a step genuinely requires driving a UI Cowork can't automate, call it out in the skill
> rather than pretending to click.

## Built-in skills you can lean on

When the task matches one of Cowork's shipped skills, USE it (write the body to invoke it)
instead of reinventing the procedure. Built-in skills:
- **pptx** / **docx** / **xlsx** — create, read, or edit PowerPoint / Word / Excel-CSV.
- **pdf** — read and manipulate PDF files.
- **loop** — edit Microsoft Loop documents.
- **canvas** — build a shareable canvas / artifact.
- **deep-research** — multi-source research with citations.
- **code-review** / **security-review** — review code changes.
- **powerbi** — Power BI reporting workflows.
- **calendar-management** / **schedule-meeting** / **meeting-intel** — calendar + meeting workflows.
- **stakeholder-comms** / **daily-briefing** — communications and briefing workflows.
- **image-operations** — inspect or transform images.

Assume ONLY the tools and skills listed above exist. Do not depend on any other skill
being installed.

## Recorded action → native capability (examples)

| Recording shows | Prefer |
| --- | --- |
| Searching / reading a Teams chat | \`m365_teams/ListChats\` → \`m365_teams/ListChatMessages\` |
| Posting to a Teams chat or channel | \`m365_teams/PostMessage\` / \`m365_teams/PostChannelMessage\` (approval) |
| Reading / searching Outlook mail | \`outlook/ListMessages\` / \`outlook/GetMessage\`; broad search \`m365_search/SearchM365\` |
| Sending / replying to email | \`outlook/CreateDraftMessage\`+\`outlook/SendDraftMessage\` / \`outlook/ReplyToMessage\` (approval) |
| Checking a calendar / free-busy | \`outlook_calendar/ListCalendarView\` / \`outlook_calendar/FindMeetingTimes\` |
| Creating / updating a meeting | \`outlook_calendar/CreateEvent\` / \`outlook_calendar/UpdateEvent\` (approval) |
| Finding / reading a SharePoint or OneDrive file | \`sharepoint_onedrive/SearchDrive\` → \`sharepoint_onedrive/ReadFileContent\` |
| Looking someone up in the org | \`me_profile/SearchPeople\` / \`me_profile/GetUserDetails\` / \`me_profile/GetOrgTree\` |
| Reading a meeting transcript | \`graph/GetMyRecentTranscripts\` → \`graph/GetMeetingTranscript\` |
| Opening / reading a local file or folder | \`Read\` / \`Glob\` / \`Grep\` |
| Reading a public web page / searching the web | \`core/web_fetch\` / \`core/web_search\` |
| Acting on GitHub — issues, PRs, releases, repos | the \`gh\` CLI via \`Bash(gh *)\` — never the browser |
| Running git, cloud, or package operations | the matching CLI via the shell (\`git\`, \`az\`/\`aws\`/\`gcloud\`, \`npm\`, \`docker\`) |
| Editing a spreadsheet / doc / deck / PDF | the \`xlsx\` / \`docx\` / \`pptx\` / \`pdf\` built-in skill |
| Querying a Power BI report | \`pbi_fabricaihub/ResolveReportIdFromUrl\` → \`pbi_fabricaihub/ExecuteQuery\` |
| Filling a form on a web app with no API or CLI | no browser automation — prefer an API/CLI, else note the manual step |
`.trim();

const COWORK_CATALOGUE = `
# Target: Microsoft 365 Copilot (Cowork) — native capability catalogue (built-ins only)

A Cowork **skill** is a \`SKILL.md\` file: optional YAML frontmatter followed by a markdown
**instructions body** (the same shape as other Copilot skills).

Frontmatter fields:
- \`name\` — kebab-case, \`^[a-z0-9-]+$\`.
- \`description\` — one line of trigger keywords (when Cowork should reach for this skill).
- \`allowed-tools\` (optional) — a YAML list of tool patterns the skill may use, e.g.
  \`Bash(gh *)\`, \`Read\`, \`Write\`, \`Grep\`, \`Glob\`. Omit it to allow the default set.

The body is plain instructions written TO the Cowork agent (imperative voice): when to use
the skill, the procedure to follow, and how to handle inputs and edge cases.

${COWORK_NATIVE_CAPABILITIES}

## Writing the SKILL.md body

- Write a GENERALIZED procedure: if the recording acted on N specific items, the body loops
  over ALL items of that kind, not the specific examples that were recorded.
- Resolve each input via the plan (a fixed value / the user provides it / the agent locates it).
- Prefer the native M365 tools, file tools, and CLIs above. Cowork has NO browser automation,
  so never write "click"/"type" UI steps — map each to an M365 tool, an API, or a CLI.
- Keep it concise and imperative. Include a short "When to use" and the ordered steps.
`.trim();

export default defineCatalogueProvider({
  architecture: "cowork",
  skill: {
    version: COWORK_CATALOGUE_VERSION,
    content: COWORK_CATALOGUE,
  },
});
