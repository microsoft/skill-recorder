// Builder eval scenarios covering the full describer task set.
//
// The two GitHub scenarios (scenarios.ts) guard the specific gh-vs-browser bug.
// These eight mirror the describer evals (evals/scenarios/*) so the builder's
// GENERALIZATION stage is guarded across every task type we test — each ships a
// FIXED approved analysis (as the describer would emit it) and a rubric asserting
// the RIGHT native capability for that task.
//
// Two flavours:
//   • "prefer a real native tool" cases — a public page → web_fetch, a spreadsheet
//     → the xlsx skill, a cloud deploy → the az CLI, merged PRs → gh, a mailbox →
//     WorkIQ. The CLI cases (gh, az) forbid the browser outright, because a headless
//     native tool is unambiguously correct. The web-read cases assert web_fetch is
//     the tool reached for, but do NOT forbid the browser: preferring web_fetch and
//     documenting a browser fallback for a page that may need a login is exactly the
//     behaviour we want, and a pure-browser regression is still caught (web_fetch
//     would be absent).
//   • genuinely browser-legit cases (expense-report, lead-to-crm) — an app with no
//     API and no CLI (Amex/Expensify, Salesforce/LinkedIn) that must be driven
//     through its UI. Here we do NOT forbid the browser; instead we assert the ONE
//     sub-step that IS native (reading local PDF receipts; reading the mailbox via
//     WorkIQ), so the rubric stays honest.

import type { BuilderScenario } from "./scenario";

/** Public pricing page → read with web_fetch, write with the xlsx skill (not the browser + Numbers UI). */
const webToSpreadsheet: BuilderScenario = {
  id: "web-to-spreadsheet",
  title: "Copy pricing from a website into a spreadsheet",
  architecture: "scout",
  platform: "darwin",
  truth:
    "The user opened the Acme pricing page in Chrome, copied the Pro plan's monthly ($49) and " +
    "annual ($490) price, and pasted both into a Numbers budget sheet. Generalized on a headless " +
    "device, the right tools are web_fetch (read the public pricing page) and the xlsx skill " +
    "(write the sheet) — not browser automation driving Numbers.",
  analysis: {
    title: "Record plan pricing",
    intent:
      "Read the Pro plan's monthly and annual price from the Acme pricing web page and record " +
      "both figures in a budget spreadsheet.",
    intentConfidence: "high",
    intentRationale:
      "The browser stayed on the Acme pricing page; the two price strings ($49 / month and " +
      "$490 / year) were copied and pasted into a Numbers budget sheet.",
    steps: [
      {
        id: "s1",
        title: "Open the Acme pricing page",
        detail: "Navigated in Chrome to the public Acme pricing page to read the Pro plan's prices.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://acme.example/pricing", "title 'Pricing — Acme'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Copy the Pro plan's monthly and annual price",
        detail: "Copied the Pro plan's monthly price ($49 / month) and annual price ($490 / year).",
        apps: ["Google Chrome"],
        evidence: ["clipboard '$49 / month'", "clipboard '$490 / year'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Record the prices in the budget spreadsheet",
        detail: "Switched to the Budget 2026 spreadsheet in Numbers and entered both prices.",
        apps: ["Numbers"],
        evidence: ["app Numbers 'Budget 2026 — Numbers'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["web_fetch"], ["xlsx"]],
    forbidden: [],
  },
};

/** A web data table → read (web_fetch if public, else the browser), write with the xlsx skill. */
const invoiceExtract: BuilderScenario = {
  id: "invoice-extract",
  title: "Extract invoice rows from a web table into a spreadsheet",
  architecture: "scout",
  platform: "darwin",
  truth:
    "The user copied three invoice rows from the Acme Books invoices page and pasted them into a " +
    "Numbers sheet. Whether the table is read with web_fetch (if public) or the browser (if the " +
    "books app needs a login) is genuinely app-dependent; what IS pinned is that the rows are " +
    "written with the xlsx skill, not by replaying the Numbers UI.",
  analysis: {
    title: "Extract invoice rows",
    intent:
      "Read every invoice row (id, customer, amount) from the Acme Books invoices web page and " +
      "record them in a spreadsheet.",
    intentConfidence: "high",
    intentRationale:
      "Three invoice rows (INV-1002 Globex $1,250.00, INV-1003 Initech $980.00, INV-1004 Umbrella " +
      "$3,400.00) were copied from the invoices page and pasted into a Numbers sheet.",
    steps: [
      {
        id: "s1",
        title: "Open the invoices page",
        detail: "Navigated in Chrome to the Acme Books invoices list to read the invoice rows.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://books.acme.example/invoices", "title 'Invoices — Acme Books'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Copy the invoice rows",
        detail: "Copied each invoice row (id, customer, amount) from the table.",
        apps: ["Google Chrome"],
        evidence: [
          "clipboard 'INV-1002\tGlobex\t$1,250.00'",
          "clipboard 'INV-1003\tInitech\t$980.00'",
          "clipboard 'INV-1004\tUmbrella\t$3,400.00'",
        ],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Record the rows in the spreadsheet",
        detail: "Switched to the Q3 Invoices spreadsheet in Numbers and pasted the rows.",
        apps: ["Numbers"],
        evidence: ["app Numbers 'Q3 Invoices — Numbers'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["web_fetch", "browser_", "browser automation"], ["xlsx"]],
    forbidden: [],
  },
};

/** Search + read articles with web_fetch, write the note to a file/doc. */
const researchCompile: BuilderScenario = {
  id: "research-compile",
  title: "Research a topic and compile quotes into a note",
  architecture: "scout",
  platform: "darwin",
  truth:
    "The user searched the web, opened two articles, copied a key quote from each, and pasted them " +
    "into a TextEdit note. Generalized, the articles are read with web_fetch and the quotes written " +
    "to a notes file (a Write/docx step) — no browser automation needed.",
  analysis: {
    title: "Compile research quotes",
    intent:
      "Search the web for material on a topic, read the top articles, and compile a key quote from " +
      "each into a notes document.",
    intentConfidence: "high",
    intentRationale:
      "A Google search was followed by two article visits (jamesclear.com, zenhabits.net); a " +
      "sentence was copied from each and pasted into a TextEdit note.",
    steps: [
      {
        id: "s1",
        title: "Search the web for the topic",
        detail: "Ran a web search for material on building better habits.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://www.google.com/search?q=building+better+habits"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Read the top articles and copy a key quote from each",
        detail: "Opened two articles and copied a key sentence from each.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://jamesclear.com/atomic-habits",
          "browser.url https://zenhabits.net/focus/",
          "clipboard 'You do not rise to the level of your goals. You fall to the level of your systems.'",
        ],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Compile the quotes into a notes document",
        detail: "Switched to TextEdit and pasted both quotes into a habits notes document.",
        apps: ["TextEdit"],
        evidence: ["app TextEdit 'habits-notes.txt — Edited'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["web_fetch"], ["docx", "write", "note", ".md", ".txt"]],
    forbidden: [],
  },
};

/** A directory of people → read natively (web_fetch or WorkIQ people), write with xlsx. */
const directoryLookup: BuilderScenario = {
  id: "directory-lookup",
  title: "Collect contact details from a directory into a spreadsheet",
  architecture: "scout",
  platform: "darwin",
  truth:
    "The user copied two people's contact lines from the company team directory and pasted them " +
    "into a Numbers contacts sheet. Generalized, the directory is read natively (web_fetch, or " +
    "WorkIQ people search for the org directory) and the contacts written with the xlsx skill.",
  analysis: {
    title: "Build a contact list",
    intent:
      "Look up people in the company team directory and compile their contact details (name, " +
      "email, phone) into a contacts spreadsheet.",
    intentConfidence: "high",
    intentRationale:
      "Two contact lines (Dana Lee — dana.lee@acme.example — +1 555 0142; Sam Ortiz — " +
      "sam.ortiz@acme.example — +1 555 0177) were copied from the team directory and pasted into " +
      "a Numbers contacts sheet.",
    steps: [
      {
        id: "s1",
        title: "Open the team directory",
        detail: "Navigated in Chrome to the company team directory to look people up.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://intranet.acme.example/directory", "title 'Team Directory — Acme'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Copy each person's contact line",
        detail: "Copied the name, email, and phone for each person from the directory.",
        apps: ["Google Chrome"],
        evidence: [
          "clipboard 'Dana Lee — dana.lee@acme.example — +1 555 0142'",
          "clipboard 'Sam Ortiz — sam.ortiz@acme.example — +1 555 0177'",
        ],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Record the contacts in the spreadsheet",
        detail: "Switched to the Contacts spreadsheet in Numbers and pasted each contact.",
        apps: ["Numbers"],
        evidence: ["app Numbers 'Contacts — Numbers'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["web_fetch", "workiq_search_people", "workiq"], ["xlsx"]],
    forbidden: ["playwright"],
  },
};

/**
 * Browser-legit: the Amex statement and Expensify have no API/CLI here, so driving
 * them through the UI is a valid choice — we do NOT forbid the browser. The native
 * sub-step we DO guard is reading the local PDF receipts as files (view / a pdf read),
 * rather than eyeballing them in a viewer.
 */
const expenseReport: BuilderScenario = {
  id: "expense-report",
  title: "Reconcile receipts against a card statement and file an expense report",
  architecture: "scout",
  platform: "darwin",
  truth:
    "The user reconciled three card charges against their PDF receipts and filed each in Expensify. " +
    "The Amex statement and Expensify are UI-only (no API/CLI), so the browser is legitimate here; " +
    "the receipts, though, are local PDF files the agent should read directly (view/pdf) instead of " +
    "opening a viewer.",
  analysis: {
    title: "File an expense report",
    intent:
      "Reconcile each business-trip charge on the card statement against its receipt and file it " +
      "as an expense, then submit the expense report.",
    intentConfidence: "high",
    intentRationale:
      "For three charges (United $412.30, Marriott $286.00, Uber $24.60) the statement line was " +
      "copied, the matching PDF receipt was checked in Preview, and the expense was entered in " +
      "Expensify; the report was then submitted.",
    steps: [
      {
        id: "s1",
        title: "Open the card statement",
        detail: "Opened the American Express recent activity page to read the trip charges.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://www.americanexpress.com/activity", "clipboard 'United Airlines\t$412.30\tJul 12'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Check each charge against its receipt PDF",
        detail: "Opened the matching PDF receipt file for each charge to confirm the amount before filing.",
        apps: ["Preview"],
        evidence: ["app Preview 'united-flight-receipt.pdf'", "app Preview 'marriott-hotel-receipt.pdf'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Enter each expense and submit the report",
        detail: "Entered each reconciled charge as an expense in Expensify, then submitted the report.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://www.expensify.com/expenses/new",
          "browser.url https://www.expensify.com/reports/submit",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["pdf", "view", "expense-report"]],
    forbidden: [],
  },
};

/** Dev release flow: merged PRs → gh (not the browser), plus git/npm/deploy in the shell. */
const releaseNotes: BuilderScenario = {
  id: "release-notes",
  title: "Compile release notes from merged PRs and deploy",
  architecture: "scout",
  platform: "darwin",
  truth:
    "The user pulled main, gathered the milestone's merged PR titles from GitHub into CHANGELOG.md, " +
    "bumped the version, deployed to production, and health-checked. The right generalization drives " +
    "GitHub with the gh CLI (gh pr list) and runs git/npm/deploy in the shell — not the github.com UI.",
  analysis: {
    title: "Cut a release",
    intent:
      "Compile release notes from the merged pull requests for a milestone into the CHANGELOG, bump " +
      "the version, deploy to production, and health-check the result.",
    intentConfidence: "high",
    intentRationale:
      "main was pulled in the terminal, the v2.4.0 milestone's merged PRs were opened on GitHub, " +
      "three PR titles were copied into CHANGELOG.md, then npm version / commit / deploy.sh / a curl " +
      "health check were run.",
    steps: [
      {
        id: "s1",
        title: "Pull the latest main branch",
        detail: "Ran git in the terminal to check out and pull the latest main.",
        apps: ["Terminal"],
        evidence: ["command 'git checkout main && git pull'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Gather the milestone's merged pull requests",
        detail: "Opened the merged PRs for the v2.4.0 milestone on GitHub and copied three PR titles.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://github.com/acme/api/pulls?q=is%3Apr+is%3Amerged+milestone%3Av2.4.0",
          "clipboard '#482 Add rate limiting to the auth API'",
        ],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Add the PR titles to the CHANGELOG",
        detail: "Pasted the merged PR titles into CHANGELOG.md in the editor.",
        apps: ["Visual Studio Code"],
        evidence: ["app 'Visual Studio Code' 'CHANGELOG.md — acme-api'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Bump the version, deploy, and health-check",
        detail: "Bumped the version with npm, committed, ran the production deploy script, and curled the health endpoint.",
        apps: ["Terminal"],
        evidence: [
          "command 'npm version minor'",
          "command './deploy.sh production'",
          "command 'curl -s https://api.acme.example/health'",
        ],
        confidence: "high",
      },
    ],
  },
  rubric: {
    mustUseAny: [["gh "], ["gh pr", "gh api", "gh release"]],
    forbidden: ["playwright", "browser_", "navigate to github"],
  },
};

/** Windows cloud deploy: the az CLI (not the Azure Portal UI), plus the xlsx skill for the log. */
const windowsDeploy: BuilderScenario = {
  id: "windows-deploy",
  title: "Deploy a web app to Azure and log the live URL (Windows)",
  architecture: "scout",
  platform: "win32",
  truth:
    "On Windows the user deployed a web app to Azure with the Azure CLI (az webapp up) in Windows " +
    "Terminal, verified it was live, and logged the URL in Deployments.xlsx. Generalized, the deploy " +
    "uses the az CLI (PowerShell on Windows) and the log uses the xlsx skill — not the Azure Portal UI.",
  analysis: {
    title: "Deploy to Azure and log the URL",
    intent:
      "Deploy the web app to Azure from the command line, verify it is live, and record the live " +
      "site URL in a deployments spreadsheet.",
    intentConfidence: "high",
    intentRationale:
      "In Windows Terminal the Azure CLI signed in and ran `az webapp up` for contoso-crm; the " +
      "deployed URL (https://contoso-crm.azurewebsites.net) was opened to verify it was live and " +
      "pasted into Deployments.xlsx.",
    steps: [
      {
        id: "s1",
        title: "Review the target resource in Azure",
        detail: "Checked the target web app's resource group before deploying.",
        apps: ["Microsoft Edge"],
        evidence: ["browser.url https://portal.azure.com/#home", "title 'Home - Microsoft Azure'"],
        confidence: "medium",
      },
      {
        id: "s2",
        title: "Sign in and deploy with the Azure CLI",
        detail: "Signed in and deployed the contoso-crm web app with the Azure CLI in Windows Terminal.",
        apps: ["Windows Terminal"],
        evidence: [
          "command 'az login'",
          "command 'az webapp up --name contoso-crm --resource-group web-prod --runtime NODE:20-lts'",
        ],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Verify the site is live",
        detail: "Opened the deployed site URL to confirm the deployment was live.",
        apps: ["Microsoft Edge"],
        evidence: ["browser.url https://contoso-crm.azurewebsites.net/", "clipboard 'https://contoso-crm.azurewebsites.net'"],
        confidence: "high",
      },
      {
        id: "s4",
        title: "Record the live URL in the deployments sheet",
        detail: "Pasted the live site URL into the Deployments.xlsx tracking sheet in Excel.",
        apps: ["Microsoft Excel"],
        evidence: ["app 'Microsoft Excel' 'Deployments.xlsx - Excel'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["az "], ["az webapp", "az login", "az group", "az account"], ["xlsx"]],
    forbidden: ["playwright", "browser_"],
  },
};

/**
 * Browser-legit for the CRM/enrichment (Salesforce Lightning and LinkedIn are UI-only
 * here), so we don't forbid the browser. The native sub-step we guard is reading the
 * inbound leads from the mailbox via WorkIQ instead of driving the Mail GUI.
 */
const leadToCrm: BuilderScenario = {
  id: "lead-to-crm",
  title: "Qualify inbound leads and enter them into the CRM",
  architecture: "scout",
  platform: "darwin",
  truth:
    "The user read two inbound leads from the Sales Leads mailbox, enriched each via LinkedIn, and " +
    "created a Salesforce contact. LinkedIn and Salesforce Lightning are UI-only, so the browser is " +
    "fine there; the mailbox, though, should be read via WorkIQ (Outlook) rather than the Mail UI.",
  analysis: {
    title: "Enter leads into the CRM",
    intent:
      "Qualify inbound sales leads from the mailbox — enriching each via a web lookup — and enter " +
      "them as contacts in the CRM.",
    intentConfidence: "high",
    intentRationale:
      "Two lead lines (Acme Corp — Jane Doe; Globex LLC — Tom Ray) were read from the Sales Leads " +
      "inbox, each person was looked up on LinkedIn, and a new Salesforce contact was created.",
    steps: [
      {
        id: "s1",
        title: "Read the inbound leads from the mailbox",
        detail: "Read the inbound sales-lead emails from the Sales Leads inbox and captured each lead line.",
        apps: ["Mail"],
        evidence: [
          "app Mail 'Inbox (2) — Sales Leads — Mail'",
          "clipboard 'Acme Corp — Jane Doe — VP Ops — jane.doe@acme.co'",
        ],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Enrich each lead via a web lookup",
        detail: "Looked each person up on LinkedIn to enrich and verify the lead.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://www.linkedin.com/in/janedoe", "browser.url https://www.linkedin.com/in/tomray"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Create a CRM contact for each lead",
        detail: "Created a new contact in Salesforce for each qualified lead and opened an opportunity.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://acme.lightning.force.com/lightning/o/Contact/new",
          "browser.url https://acme.lightning.force.com/lightning/o/Opportunity/new",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["workiq_search_emails", "workiq_list_emails", "workiq_get_email", "workiq"]],
    forbidden: [],
  },
};

/** UI-only web portal interaction targeting portable agent-skill via agent-browser CLI. */
const agentPortalAutomation: BuilderScenario = {
  id: "agent-portal-automation",
  title: "Extract portal data and submit confirmation via agent-browser",
  architecture: "agent-skill",
  platform: "darwin",
  truth:
    "The user navigated to an internal vendor portal with no API or CLI, extracted status records, " +
    "and confirmed an order update. Because the target is a generic agent-skill without host-specific " +
    "browser tools, the skill maps the interaction to the portable agent-browser CLI.",
  analysis: {
    title: "Vendor portal order confirmation",
    intent:
      "Navigate to the vendor portal, inspect pending order statuses using accessibility snapshots, " +
      "and submit order confirmation via agent-browser.",
    intentConfidence: "high",
    intentRationale:
      "Order items were viewed on an internal vendor portal (vendor.internal.example/orders) and " +
      "confirmed through the web interface.",
    steps: [
      {
        id: "s1",
        title: "Open vendor orders portal",
        detail: "Navigated to the vendor portal to inspect pending orders.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://vendor.internal.example/orders", "title 'Vendor Portal — Orders'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Snapshot and confirm pending orders",
        detail: "Captured page elements, confirmed the open batch, and submitted the confirmation.",
        apps: ["Google Chrome"],
        evidence: ["button 'Confirm All'", "status 'Batch 489 confirmed'"],
        confidence: "high",
      },
    ],
  },
  rubric: {
    mustUseAny: [["agent-browser", "Bash(agent-browser:*)", "Bash"]],
    forbidden: ["browser_navigate", "browser_click", "workiq"],
  },
};

/** The nine task scenarios that mirror the describer eval set. */
export const nativeToolScenarios: BuilderScenario[] = [
  webToSpreadsheet,
  invoiceExtract,
  researchCompile,
  directoryLookup,
  expenseReport,
  releaseNotes,
  windowsDeploy,
  leadToCrm,
  agentPortalAutomation,
];
