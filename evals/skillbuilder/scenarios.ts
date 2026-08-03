// Skill builder eval scenarios.
//
// Two fixed, approved analyses chosen to exercise the SkillBuilder's richer plan
// shape end to end:
//
//   • price-tracker — a recurring read-from-one-page-then-record task. It should
//     yield a **fixed** input (the canonical page URL), calculation steps (read the
//     figure, compute the change) and an action step (append the row), reaching for
//     web_fetch + the xlsx skill rather than driving the browser + a spreadsheet UI.
//   • github-issue-triage — the gh-vs-browser case, as a skill. It should generalize
//     to the `gh` CLI (never the browser), split "decide which issues qualify"
//     (calculation) from "comment + label" (action), and gate the mutating action
//     with a confirmation pause because it posts on the user's behalf.
//
// Together they assert the whole new contract: input `source` vocabulary, typed
// calculation/action steps, native-tool choice, and confirmation on the risky step.
//
// A third group targets the **Cowork** (Microsoft 365 Copilot) catalogue. Cowork has
// NO browser automation, so every recorded web-UI step must map to a first-class M365
// tool. These three cover the biggest M365 surfaces — Teams, Outlook mail, and
// Calendar — and each asserts the right `server/Tool` is reached for while the browser
// (playwright/click and the *.office.com / teams.microsoft.com hosts) is forbidden.

import type { SkillBuilderScenario } from "./scenario";

/** Read one canonical page, compute a delta, append a dated row to a tracker sheet. */
const priceTracker: SkillBuilderScenario = {
  id: "price-tracker-skill",
  title: "Track a plan price over time in a spreadsheet",
  architecture: "scout",
  platform: "darwin",
  truth:
    "Every Monday the user opens the SAME public Acme pricing page in Chrome, reads the Pro " +
    "plan's monthly price, works out how much it changed since the last recorded figure, and " +
    "appends a new dated row (date, price, change) to their Pricing Tracker spreadsheet. " +
    "Generalized on a headless device the right tools are web_fetch (read the fixed public page) " +
    "and the xlsx skill (append the row) — the page URL is a fixed input, the change is a " +
    "calculation, and appending the row is the one action.",
  analysis: {
    title: "Record the weekly Pro plan price",
    intent:
      "Every week, read the Pro plan's current monthly price from the public Acme pricing page, " +
      "compute how much it changed since the last recorded value, and append a new dated row " +
      "(date, price, change vs last week) to the Pricing Tracker spreadsheet.",
    intentConfidence: "high",
    intentRationale:
      "The browser opened the same Acme pricing page URL; the Pro plan monthly price ($49 / month) " +
      "was read and a new dated row was added below the previous week's row in a Numbers sheet " +
      "titled 'Pricing Tracker'.",
    steps: [
      {
        id: "s1",
        title: "Open the Acme pricing page",
        detail:
          "Navigated in Chrome to the public Acme pricing page — the same canonical URL used every " +
          "week — to read the Pro plan's current monthly price.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://acme.example/pricing", "title 'Pricing — Acme'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Read the Pro plan's monthly price",
        detail: "Read the Pro plan's monthly price ($49 / month) from the pricing table.",
        apps: ["Google Chrome"],
        evidence: ["clipboard '$49 / month'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Work out the change since last week",
        detail:
          "Compared this week's price against the previous row's price in the tracker to work out " +
          "the change (this week $49 vs last week $45, so +$4).",
        apps: ["Numbers"],
        evidence: ["app Numbers 'Pricing Tracker — Numbers'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Append a dated row to the Pricing Tracker",
        detail:
          "Added a new row to the Pricing Tracker spreadsheet with today's date, the price, and the " +
          "change versus the previous week.",
        apps: ["Numbers"],
        evidence: ["app Numbers 'Pricing Tracker — Numbers'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["web_fetch"], ["xlsx"]],
    forbidden: [],
    minValues: 1,
    minCalculations: 1,
    minActions: 1,
  },
};

/** Triage bug issues recorded in the browser — should generalize to the gh CLI, and gate the mutating step. */
const githubIssueTriage: SkillBuilderScenario = {
  id: "github-issue-triage-skill",
  title: "Triage new bug issues on GitHub",
  architecture: "scout",
  platform: "darwin",
  truth:
    "In Chrome the user opened the acme/api repo's open issues filtered to label:bug with no " +
    "assignee, read a new report, posted a comment asking the reporter for exact reproduction " +
    "steps and their version, and applied the 'needs-info' label — a triage pass they repeat for " +
    "every new unassigned bug. The right generalization drives GitHub with the gh CLI (gh issue " +
    "list / gh issue comment / gh issue edit --add-label), not the browser UI; deciding which " +
    "issues qualify is a calculation, while commenting + labelling is a mutating action that " +
    "should pause for the user's confirmation because it posts on their behalf.",
  analysis: {
    title: "Triage new bug issues",
    intent:
      "Triage newly reported, unassigned bug issues in the acme/api GitHub repository: for each " +
      "open issue labeled 'bug' with no assignee, post a comment asking the reporter for exact " +
      "reproduction steps and their version, then add the 'needs-info' label.",
    intentConfidence: "high",
    intentRationale:
      "The browser stayed on github.com/acme/api issue pages throughout; the same comment text " +
      "and the same 'needs-info' label were applied to a bug issue.",
    steps: [
      {
        id: "s1",
        title: "Open the repo's open bug issues on GitHub",
        detail:
          "Navigated in Chrome to the acme/api issues list filtered to open bug issues with no " +
          "assignee to find reports that still need triage.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://github.com/acme/api/issues?q=is%3Aissue+is%3Aopen+label%3Abug+no%3Aassignee",
          "title 'Issues · acme/api'",
        ],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Open a new bug report to read it",
        detail: "Opened issue #214 in Chrome to read the reported bug before triaging it.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://github.com/acme/api/issues/214"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Comment asking for reproduction steps",
        detail:
          "Typed a comment into the issue's comment box and submitted it, asking the reporter for " +
          "exact reproduction steps and the version they are on.",
        apps: ["Google Chrome"],
        evidence: [
          "clipboard 'Thanks for the report! Could you share exact reproduction steps and the version you're on?'",
          "browser.url https://github.com/acme/api/issues/214",
        ],
        confidence: "high",
      },
      {
        id: "s4",
        title: "Apply the needs-info label",
        detail:
          "Opened the Labels sidebar on the issue and applied the 'needs-info' label to mark it as " +
          "waiting on the reporter.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://github.com/acme/api/issues/214", "label 'needs-info'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["gh "], ["gh issue", "gh api"]],
    forbidden: ["playwright", "browser_", "click", "navigate to github", "github.com/acme"],
    minValues: 1,
    minCalculations: 1,
    minActions: 1,
  },
};

/** Same recording as githubIssueTriage, targeting the Generic-agent catalogue: must still reach
 *  for the gh CLI (a universal primitive — the shell), but the plan must name NO product-specific
 *  tool ID (no workiq_*, no m365_*, no named browser-tool suite) since the destination agent is
 *  unknown. */
const githubIssueTriageGeneric: SkillBuilderScenario = {
  ...githubIssueTriage,
  id: "github-issue-triage-generic",
  title: "Triage new bug issues on GitHub (generic agent)",
  architecture: "generic",
  rubric: {
    mustUseAny: [["gh "], ["gh issue", "gh api"]],
    forbidden: [
      "playwright",
      "browser_",
      "workiq",
      "m365_",
      "click",
      "navigate to github",
      "github.com/acme",
    ],
    minValues: 1,
    minCalculations: 1,
    minActions: 1,
  },
};

/* --- Cowork (Microsoft 365 Copilot) scenarios ----------------------------- */

/** Read a Teams channel in the web app, summarize, post a digest — must use the m365_teams tool, never the browser. */
const coworkTeamsDigest: SkillBuilderScenario = {
  id: "cowork-teams-digest",
  title: "Post a morning digest to the leads Teams channel",
  architecture: "cowork",
  platform: "darwin",
  truth:
    "Every morning the user opens the 'Eng — Announcements' channel in the Teams web app, reads " +
    "the overnight messages, writes a short 3-bullet digest, and posts it to the 'Leads' channel. " +
    "Cowork has no browser automation, so the right generalization reads the source channel with " +
    "m365_teams/ListChannelMessages and posts with m365_teams/PostChannelMessage — summarizing is " +
    "a calculation and posting is the one mutating action, which pauses for confirmation because it " +
    "posts on the user's behalf. Driving teams.microsoft.com in a browser is wrong.",
  analysis: {
    title: "Post a morning digest to the leads channel",
    intent:
      "Each morning, read the overnight messages in the Eng Announcements Teams channel, summarize " +
      "them into a short digest, and post that digest to the Leads channel for the leads to skim.",
    intentConfidence: "high",
    intentRationale:
      "The Teams web app stayed on the Eng Announcements channel while messages were read, and the " +
      "same digest text was then posted into the Leads channel.",
    steps: [
      {
        id: "s1",
        title: "Open the Eng Announcements channel",
        detail:
          "Opened the 'Eng — Announcements' channel in the Teams web app to read the messages posted " +
          "overnight.",
        apps: ["Microsoft Teams"],
        evidence: [
          "browser.url https://teams.microsoft.com/l/channel/19%3Aeng-announcements/Announcements",
          "title 'Eng — Announcements | Microsoft Teams'",
        ],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Read the overnight messages",
        detail: "Read the overnight posts in the channel to capture what happened.",
        apps: ["Microsoft Teams"],
        evidence: ["clipboard 'Deploy 4.2 shipped; incident #88 resolved; on-call rotates to Priya'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Write a 3-bullet digest",
        detail:
          "Condensed the overnight messages into a short three-bullet digest of what the leads need " +
          "to know.",
        apps: ["Microsoft Teams"],
        evidence: ["clipboard '• Deploy 4.2 shipped • Incident #88 resolved • On-call: Priya'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Post the digest to the Leads channel",
        detail: "Posted the three-bullet digest into the 'Leads' channel.",
        apps: ["Microsoft Teams"],
        evidence: [
          "browser.url https://teams.microsoft.com/l/channel/19%3Aleads/Leads",
          "clipboard '• Deploy 4.2 shipped • Incident #88 resolved • On-call: Priya'",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["m365_teams"], ["postchannelmessage", "postmessage", "replytochannelmessage"]],
    forbidden: ["playwright", "browser_", "click", "teams.microsoft.com"],
    minCalculations: 1,
    minActions: 1,
  },
};

/** Triage unread mail in Outlook web and reply — must use the outlook tool, never the browser. */
const coworkOutlookReply: SkillBuilderScenario = {
  id: "cowork-outlook-reply",
  title: "Acknowledge unread support emails",
  architecture: "cowork",
  platform: "darwin",
  truth:
    "The user triages the Support mailbox in Outlook on the web: for each unread customer email " +
    "they send a short acknowledgement reply. Cowork can't drive a browser, so the right tools are " +
    "outlook/ListMessages + outlook/GetMessage to read the unread mail and outlook/ReplyToMessage " +
    "(or CreateDraftMessage + SendDraftMessage) to send the acknowledgement — deciding which " +
    "messages qualify is a calculation, and sending the reply is the mutating action that pauses " +
    "for confirmation. Replaying outlook.office.com in a browser is wrong.",
  analysis: {
    title: "Acknowledge unread support emails",
    intent:
      "Triage the Support mailbox: for each unread customer email, send a short acknowledgement " +
      "reply letting them know their request was received and will be followed up.",
    intentConfidence: "high",
    intentRationale:
      "Outlook on the web stayed in the Support inbox; an unread customer email was opened and the " +
      "same acknowledgement text was sent as a reply.",
    steps: [
      {
        id: "s1",
        title: "Open the Support inbox",
        detail: "Opened the Support shared mailbox in Outlook on the web and filtered to unread mail.",
        apps: ["Microsoft Outlook"],
        evidence: ["browser.url https://outlook.office.com/mail/support/", "title 'Inbox — Support'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Read an unread customer email",
        detail: "Opened an unread customer email to read the request before acknowledging it.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Order #5512 still hasn't arrived — can you check?'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Decide it needs an acknowledgement",
        detail:
          "Judged that the unread customer email is a new request that should get an acknowledgement " +
          "reply.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Order #5512 still hasn't arrived — can you check?'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Send the acknowledgement reply",
        detail: "Replied to the customer with a short acknowledgement that their request was received.",
        apps: ["Microsoft Outlook"],
        evidence: [
          "clipboard 'Thanks — we've received your request and will follow up within one business day.'",
          "browser.url https://outlook.office.com/mail/support/",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["outlook/"], ["replytomessage", "senddraftmessage", "createdraftmessage", "replyalltomessage"]],
    forbidden: ["playwright", "browser_", "click", "outlook.office.com", "outlook.office365.com"],
    minCalculations: 1,
    minActions: 1,
  },
};

/** Find a slot everyone can make and book a follow-up — must use outlook_calendar, never the browser. */
const coworkCalendarSchedule: SkillBuilderScenario = {
  id: "cowork-calendar-schedule",
  title: "Book a follow-up meeting with the call attendees",
  architecture: "cowork",
  platform: "darwin",
  truth:
    "After a customer call the user opens Outlook Calendar in the browser, checks the two attendees' " +
    "availability next week, and books a 30-minute follow-up. Cowork has no browser automation, so " +
    "the right tools are outlook_calendar/FindMeetingTimes (find a slot everyone can make) and " +
    "outlook_calendar/CreateEvent (book it) — resolving the slot is a calculation and creating the " +
    "event is the mutating action that pauses for confirmation because it invites people. Driving " +
    "the outlook.office.com calendar UI is wrong.",
  analysis: {
    title: "Book a follow-up meeting with the attendees",
    intent:
      "Schedule a 30-minute follow-up meeting with the two attendees from the call by finding a time " +
      "that works for everyone next week and creating the calendar event.",
    intentConfidence: "high",
    intentRationale:
      "Outlook Calendar on the web was used to inspect Priya and Sam's availability next week, and a " +
      "new 30-minute follow-up event was created with both as attendees.",
    steps: [
      {
        id: "s1",
        title: "Open Outlook Calendar",
        detail: "Opened Outlook Calendar on the web to look at next week for a follow-up slot.",
        apps: ["Microsoft Outlook"],
        evidence: ["browser.url https://outlook.office.com/calendar/view/week", "title 'Calendar — Outlook'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Check the attendees' availability next week",
        detail: "Compared Priya and Sam's free/busy next week to find a 30-minute slot they can both make.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Priya free Tue 2pm, Wed 10am; Sam free Tue 2pm'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Pick a slot everyone can make",
        detail: "Chose Tuesday 2:00pm as the slot both attendees are free for.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Tue 2:00pm works for both'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Create the 30-minute follow-up event",
        detail: "Created a 30-minute 'Follow-up' calendar event at the chosen slot and invited both attendees.",
        apps: ["Microsoft Outlook"],
        evidence: [
          "browser.url https://outlook.office.com/calendar/deeplink/compose",
          "clipboard 'Follow-up — 30 min — Priya, Sam'",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [
      ["outlook_calendar"],
      ["findmeetingtimes", "listcalendarview", "listevents", "getschedule"],
      ["createevent"],
    ],
    forbidden: ["playwright", "browser_", "click", "outlook.office.com"],
    minCalculations: 1,
    minActions: 1,
  },
};

export const skillScenarios: SkillBuilderScenario[] = [
  priceTracker,
  githubIssueTriage,
  githubIssueTriageGeneric,
  coworkTeamsDigest,
  coworkOutlookReply,
  coworkCalendarSchedule,
];