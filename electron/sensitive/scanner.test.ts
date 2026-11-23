import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { SensitiveReport } from "../../common/sensitive";
import { createDescriberTools, type ToolContext } from "../describer/tools";
import { buildRedactor, loadSensitiveReport, saveSensitiveReport, scanSession } from "./scanner";

const STARTED_AT = 10_000;

// Fake, non-real values shaped to trip specific detectors.
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // 36 body chars
const CARD = "4111 1111 1111 1111"; // Luhn-valid Visa test number
const EMAIL = "dev@internal.example.com";
const PERSON = "Ada Lovelace";
const PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAsyntheticNonSecretKeyMaterialForRegressionTestingOnly",
  "VGhpcyBpcyBub3QgYSByZWFsIHByaXZhdGUga2V5",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

async function invoke(ctx: ToolContext, name: string, args: Record<string, unknown> = {}) {
  const tool = createDescriberTools(ctx).find((candidate) => candidate.name === name);
  assert.ok(tool?.handler);
  return String(await tool.handler(args, {
    sessionId: "test", toolCallId: "test", toolName: name, arguments: args,
  }));
}

async function terminalFixture(root: string, chunks: string[]) {
  const id = "redaction-regression";
  const dir = path.join(root, id);
  await mkdir(path.join(dir, "terminal"), { recursive: true });
  await writeFile(path.join(dir, "session.json"), JSON.stringify({ id, startedAt: STARTED_AT }));
  await writeFile(path.join(dir, "events.jsonl"), "");
  const cast = [
    JSON.stringify({ version: 2, width: 80, height: 24 }),
    ...chunks.map((chunk, index) => JSON.stringify([index + 1, "o", chunk])),
  ].join("\n") + "\n";
  await writeFile(path.join(dir, "terminal", "output.cast"), cast);
  const scan = await scanSession(id);
  const context: ToolContext = {
    sessionDir: dir, startedAt: STARTED_AT, extractor: null,
    redaction: { current: {
      redactText: buildRedactor(scan.values),
      redactTerminalOutput: scan.redactTerminalOutput,
      frameRedactor: null,
    } },
    onSubmit: () => undefined,
  };
  return { ...scan, context, cast };
}

function event(seq: number, offsetMs: number, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    seq,
    t: offsetMs,
    epoch: STARTED_AT + offsetMs,
    type,
    source: "test",
    payload,
  });
}

async function seedSession(root: string, id: string): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });

  await writeFile(
    path.join(dir, "session.json"),
    JSON.stringify({ id, startedAt: STARTED_AT, stoppedAt: STARTED_AT + 9_000 }),
  );

  const lines = [
    event(1, 1_500, "clipboard.change", { textPreview: `card ${CARD} for the test account` }),
    event(2, 3_000, "terminal.command", { command: `echo ${GH_TOKEN}` }),
    event(3, 2_500, "marker", { note: `met with ${PERSON} to review; ping ${EMAIL}` }),
    event(4, 4_000, "app.title-change", { app: "Chrome", title: "Nothing sensitive here" }),
    // Same GitHub token again, later — should dedupe into one finding (occurrences: 2).
    event(5, 5_000, "terminal.command", { command: `echo ${GH_TOKEN}` }),
  ];
  await writeFile(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");

  await writeFile(
    path.join(dir, "narration.json"),
    JSON.stringify({
      version: 1,
      language: "en",
      segments: [
        { atMs: 6_000, text: `my email is ${EMAIL}` },
        { atMs: 7_000, text: "nothing to see here" },
      ],
    }),
  );
}

async function withSessionRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-sensitive-"));
  const previousRoot = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  try {
    await fn(root);
  } finally {
    if (previousRoot === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

test("scanSession detects secrets + structured PII across sources and returns raw values", async () => {
  await withSessionRoot(async (root) => {
    const id = "scan-test";
    await seedSession(root, id);

    const { report, values } = await scanSession(id);

    assert.equal(report.sessionId, id);

    // Secretlint finds the GitHub token; the two commands collapse to one finding
    // seen twice, timed at the earliest occurrence (3_000, not 5_000).
    const token = report.findings.find((f) => f.label === "GitHub token");
    assert.ok(token, "expected a GitHub token finding");
    assert.equal(token.occurrences, 2);
    assert.equal(token.atMs, 3_000);
    assert.equal(token.severity, "high");

    // Structured PII (deterministic, in-repo).
    assert.ok(report.findings.some((f) => f.category === "credit-card"), "expected a card finding");
    assert.ok(report.findings.some((f) => f.category === "email"), "expected an email finding");

    // Findings sort high-severity first.
    assert.equal(report.findings[0].severity, "high");

    // Raw values are returned to the main process (for the redactor) but never in
    // the report itself.
    assert.ok(values.includes(GH_TOKEN));
    assert.ok(values.includes(CARD));
    assert.ok(values.includes(EMAIL));

    const serialized = JSON.stringify(report);
    for (const raw of [GH_TOKEN, CARD, EMAIL]) {
      assert.ok(!serialized.includes(raw), `report must not contain raw value: ${raw}`);
    }
    for (const f of report.findings) {
      assert.match(f.redactedValue, /•/, "redacted value should be masked");
    }
  });
});

test("scanSession leaves personal names alone (NER layer removed)", async () => {
  await withSessionRoot(async (root) => {
    const id = "names-test";
    await seedSession(root, id);

    const { values } = await scanSession(id);
    // The seeded marker note names a person; with the NER layer removed a bare name
    // is neither detected nor added to the redaction values (secrets + PII only).
    assert.ok(!values.includes(PERSON), "a bare name must not be a redaction value");
  });

});

test("scanSession streams and scans terminal output split across PTY chunks", async () => {
  await withSessionRoot(async (root) => {
    const id = "terminal-output";
    const dir = path.join(root, id);
    await mkdir(path.join(dir, "terminal"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ id, startedAt: STARTED_AT, stoppedAt: STARTED_AT + 2_000 }),
    );
    await writeFile(path.join(dir, "events.jsonl"), "");
    const cast = [
      JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 10 }),
      JSON.stringify([0.5, "o", `token: ${GH_TOKEN.slice(0, 20)}`]),
      JSON.stringify([0.6, "o", `${GH_TOKEN.slice(20)}\r\n`]),
    ].join("\n");
    await writeFile(path.join(dir, "terminal", "output.cast"), `${cast}\n`);

    const { report, values } = await scanSession(id);
    assert.ok(values.includes(GH_TOKEN));
    const finding = report.findings.find((item) => item.label === "GitHub token");
    assert.equal(finding?.source, "terminal-output");
    assert.equal(JSON.stringify(report).includes(GH_TOKEN), false);
  });
});

test("terminal secrets are masked across rows, pages and time windows without losing surrounding output", async () => {
  await withSessionRoot(async (root) => {
    const first = GH_TOKEN.slice(0, 20);
    const second = GH_TOKEN.slice(20);
    const { context, values, cast, report } = await terminalFixture(root, [
      `before ${first}`, `${second} after\r\n`, "ordinary diagnostic output\r\n",
    ]);
    assert.ok(values.includes(GH_TOKEN));
    assert.equal(report.findings.find((finding) => finding.label === "GitHub token")?.atMs, 1000);
    const page = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 0, limit: 1 }));
    assert.equal(page.nextCursor, 1);
    assert.equal(page.hits[0].cursor, 0);
    assert.equal(page.hits[0].atMs, 1000);
    assert.ok(page.hits[0].text.startsWith("before "));
    assert.ok(!page.hits[0].text.includes(first));
    const next = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 0, cursor: page.nextCursor }));
    assert.ok(!next.hits[0].text.includes(second));
    assert.ok(next.hits[0].text.endsWith(" after\r\n"));
    assert.equal(next.hits[1].text, "ordinary diagnostic output\r\n");
    const window = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 2000, toMs: 2000 }));
    assert.equal(window.hits.length, 1);
    assert.ok(!window.hits[0].text.includes(second));
    const query = JSON.parse(await invoke(context, "search_terminal_output", { query: first }));
    assert.equal(query.hits.length, 1, "search still matches the original text");
    assert.ok(!query.hits[0].text.includes(first));
    assert.equal(await readFile(path.join(context.sessionDir, "terminal", "output.cast"), "utf8"), cast);
    context.redaction.current = null;
    const raw = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 0 }));
    assert.equal(raw.hits[0].text, `before ${first}`);
    assert.equal(raw.hits[1].text, `${second} after\r\n`);
  });
});

test("private keys printed across lines are detected and their body is masked in terminal excerpts", async () => {
  await withSessionRoot(async (root) => {
    const { context, report, values } = await terminalFixture(root, [
      "before\r\n", ...PRIVATE_KEY.split("\n").map((line) => `${line}\r\n`), "after\r\n",
    ]);
    assert.ok(report.findings.some((finding) => finding.category === "private-key"));
    assert.ok(values.some((value) => value.includes(PRIVATE_KEY.split("\n")[1])));
    const page = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 0 }));
    assert.equal(page.hits[0].text, "before\r\n");
    assert.equal(page.hits.at(-1).text, "after\r\n");
    for (const body of PRIVATE_KEY.split("\n").slice(1, -1)) {
      assert.ok(!page.hits.some((hit: { text: string }) => hit.text.includes(body)));
    }
  });
});

test("ANSI controls split at any character do not hide tokens from detection or masking", async () => {
  await withSessionRoot(async (root) => {
    for (const control of ["\u001b[32m", "\u001b]0;window title\u0007", "\u001b]0;title\u001b\\", "\u009b32m"]) {
      for (let split = 1; split < control.length; split++) {
        const { context, values } = await terminalFixture(root, [
          control.slice(0, split), `${control.slice(split)}${GH_TOKEN}\u001b[0m\r\n`,
        ]);
        assert.ok(values.includes(GH_TOKEN), `missed control split at ${split}`);
        const result = await invoke(context, "search_terminal_output", { fromMs: 0 });
        assert.ok(!result.includes(GH_TOKEN));
      }
    }
  });
});

test("JSON tools mask raw values before escaping or truncating and leave ordinary fields unchanged", async () => {
  await withSessionRoot(async (root) => {
    const id = "json-redaction";
    const dir = path.join(root, id);
    await mkdir(path.join(dir, "terminal"), { recursive: true });
    const values = [PRIVATE_KEY, 'secret"with\\escapes', `long-${"K".repeat(2200)}-secret`];
    const note = `before\n${values.join("\n")}\nafter`;
    await writeFile(path.join(dir, "events.jsonl"), event(1, 1000, "marker", { note, app: "Terminal" }) + "\n");
    await writeFile(path.join(dir, "terminal", "commands.jsonl"), JSON.stringify({
      id: "cmd-1", command: note, cwd: "C:\\work", startAtMs: 1000, endAtMs: 2000,
    }) + "\n");
    await writeFile(path.join(dir, "bundle.json"), JSON.stringify({
      session: { durationMs: 2000, platform: "win32" }, stats: { stepCount: 1 },
      steps: [{
        index: 0, startMs: STARTED_AT, durationMs: 2000, boundary: "start", app: "Terminal",
        titles: [note], hosts: [], urls: [], commands: [note], clipboardCount: 0,
        markers: [note], frames: [], summary: note,
      }],
    }));
    const context: ToolContext = {
      sessionDir: dir, startedAt: STARTED_AT, extractor: null,
      redaction: { current: { redactText: buildRedactor(values), frameRedactor: null } },
      onSubmit: () => undefined,
    };
    const expected = buildRedactor(values)(note);
    const events = JSON.parse(await invoke(context, "get_events"));
    assert.equal(events.events[0].note, expected);
    assert.equal(events.events[0].app, "Terminal");
    const commands = JSON.parse(await invoke(context, "list_terminal_commands"));
    assert.equal(commands.commands[0].command, expected);
    assert.equal(commands.commands[0].cwd, "C:\\work");
    const timeline = JSON.parse(await invoke(context, "get_timeline"));
    assert.equal(timeline.steps[0].commands[0], expected);
    assert.equal(timeline.steps[0].markers[0], expected);
    assert.equal(timeline.steps[0].titles[0], expected);
    assert.equal(timeline.steps[0].summary, expected);
    context.imported = {
      version: 1, file: "import.mp4", name: "Demo", importedAt: STARTED_AT,
      bytes: 100, durationMs: 2000, width: 640, height: 360, hasAudio: false, details: note, language: "en",
    };
    const imported = JSON.parse(await invoke(context, "get_timeline"));
    assert.equal(imported.additionalDetails, expected);
    context.redaction.current = null;
    const unprotected = JSON.parse(await invoke(context, "get_timeline"));
    assert.equal(unprotected.additionalDetails, note);
    });
});

test("one-character terminal fragments and ANSI embedded in tokens cannot reconstruct a detected value", async () => {
  await withSessionRoot(async (root) => {
    for (const chunks of [
      [...GH_TOKEN],
      [GH_TOKEN.slice(0, 20) + "\u001b[3", "2m" + GH_TOKEN.slice(20)],
    ]) {
      const { context, values } = await terminalFixture(root, chunks);
      assert.ok(values.includes(GH_TOKEN));
      const { hits } = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 0, limit: 50 }));
      const reconstructed = hits.map((hit: { text: string }) => hit.text).join("");
      assert.ok(!reconstructed.includes(GH_TOKEN));
      assert.match(reconstructed, /••••/);
    }
  });
});

test("multiline window boundaries retain secrets without duplicating findings", async () => {
  await withSessionRoot(async (root) => {
    for (const value of [GH_TOKEN, PRIVATE_KEY]) {
      const padding = "log\n".repeat(16_380);
      const { context, values, report } = await terminalFixture(root, [
        padding + value.slice(0, 40), value.slice(40) + "\n", "done\n",
      ]);
      assert.ok(values.includes(value));
      const finding = report.findings.find((item) =>
        item.label === (value === GH_TOKEN ? "GitHub token" : "Private key"));
      assert.equal(finding?.occurrences, 1);
      assert.equal(finding?.atMs, 1000);
      const page = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 2000 }));
      assert.ok(!page.hits.some((hit: { text: string }) => hit.text.includes(value.slice(40).trim()) && value.length > 40));
      assert.equal(page.hits.at(-1).text, "done\n");
    }
  });
});

test("excerpts starting or ending inside a private key mask only the intersecting span", async () => {
  await withSessionRoot(async (root) => {
    const body = "MIIE" + "QUJD".repeat(1500);
    const value = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const { context, values } = await terminalFixture(root, [`before\n${value}\nafter`]);
    assert.ok(values.includes(value));
    const start = JSON.parse(await invoke(context, "search_terminal_output", { fromMs: 0 }));
    assert.ok(start.hits[0].text.startsWith("before\n"));
    assert.ok(!start.hits[0].text.includes("QUJD"));
    assert.ok(start.hits[0].text.length <= 2000);
    const end = JSON.parse(await invoke(context, "search_terminal_output", { query: "after" }));
    assert.ok(end.hits[0].text.endsWith("\nafter"));
    assert.ok(!end.hits[0].text.includes("QUJD"));
  });
});

test("protected benign terminal output retains command filtering, cursors, timing and result shape", async () => {
  await withSessionRoot(async (root) => {
    const { context, report } = await terminalFixture(root, [
      "\u001b[32mbuild started\u001b[0m\r\n", "a".repeat(2500), "build finished\r\n",
    ]);
    assert.equal(report.totalFindings, 0);
    await writeFile(path.join(context.sessionDir, "terminal", "commands.jsonl"), JSON.stringify({
      id: "cmd-1", command: "build", cwd: "C:\\work", startAtMs: 1000, endAtMs: 3000,
    }) + "\n");
    const protection = context.redaction.current;
    for (const args of [
      { commandId: "cmd-1", limit: 1 },
      { fromMs: 0, cursor: 1 },
      { query: "finished", commandId: "cmd-1" },
      { fromMs: 2000, toMs: 2000 },
    ]) {
      context.redaction.current = protection;
      const protectedOutput = await invoke(context, "search_terminal_output", args);
      context.redaction.current = null;
      assert.equal(await invoke(context, "search_terminal_output", args), protectedOutput);
    }
  });
});

test("scanSession scans the whole event payload, not just primary fields", async () => {
  await withSessionRoot(async (root) => {
    const id = "payload-coverage";
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ id, startedAt: STARTED_AT, stoppedAt: STARTED_AT + 2_000 }),
    );
    // A secret that lives ONLY in a non-primary payload field — a terminal `cwd`,
    // which get_events emits but the old curated scan (command-only) never read.
    const CWD_TOKEN = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    await writeFile(
      path.join(dir, "events.jsonl"),
      event(1, 500, "terminal.command", { command: "ls -la", cwd: `/srv/ci/${CWD_TOKEN}` }) + "\n",
    );

    const { report, values } = await scanSession(id);
    assert.ok(values.includes(CWD_TOKEN), "a secret in a non-primary field must be redacted");
    assert.ok(
      report.findings.some((f) => f.source === "other"),
      "a non-primary field's finding is sourced as 'other'",
    );
    assert.ok(!JSON.stringify(report).includes(CWD_TOKEN), "report must not carry the raw value");
  });
});

test("scanSession does not leak an adjacent value through a sibling finding's snippet", async () => {
  await withSessionRoot(async (root) => {
    const id = "adjacent-values";
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ id, startedAt: STARTED_AT, stoppedAt: STARTED_AT + 2_000 }),
    );
    // Two emails close enough that each falls inside the other's ±32-char snippet
    // window: each finding's snippet must mask BOTH, or one leaks raw as the other's
    // "context". (Short values so the full neighbor fits in the window.)
    const A = "alice@corp.example.com";
    const B = "bob@corp.example.com";
    await writeFile(
      path.join(dir, "events.jsonl"),
      event(1, 500, "marker", { note: `invite ${A} and ${B}` }) + "\n",
    );

    const { report } = await scanSession(id);
    assert.ok(report.findings.length >= 2, "both emails should be found");
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(A), "first email must not leak (incl. as a neighbor's snippet)");
    assert.ok(!serialized.includes(B), "second email must not leak (incl. as a neighbor's snippet)");
  });
});

test("buildRedactor masks every detected value, longest first, and is a no-op when empty", async () => {
  const redact = buildRedactor([GH_TOKEN, EMAIL, "ab"]); // "ab" below MIN_REDACT_LEN, ignored
  const text = `token ${GH_TOKEN} mail ${EMAIL} ab`;
  const out = redact(text);
  assert.ok(!out.includes(GH_TOKEN));
  assert.ok(!out.includes(EMAIL));
  assert.ok(out.includes("••••"));
  assert.ok(out.includes(" ab")); // short value left untouched

  const noop = buildRedactor([]);
  assert.equal(noop("nothing to redact here"), "nothing to redact here");
});

test("scanSession returns a clean result when nothing sensitive is present", async () => {
  await withSessionRoot(async (root) => {
    const id = "clean-test";
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ id, startedAt: STARTED_AT, stoppedAt: STARTED_AT + 1_000 }),
    );
    await writeFile(
      path.join(dir, "events.jsonl"),
      event(1, 500, "marker", { note: "reviewed the onboarding docs" }) + "\n",
    );

    const { report, values } = await scanSession(id);
    assert.equal(report.totalFindings, 0);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(values, []);
  });
});

test("scanSession is defensive: missing artifacts yield an empty result, not a throw", async () => {
  await withSessionRoot(async (root) => {
    const id = "empty-test";
    await mkdir(path.join(root, id), { recursive: true });
    const { report, values } = await scanSession(id);
    assert.equal(report.totalFindings, 0);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(values, []);
  });
});

const sampleReport = (id: string): SensitiveReport => ({
  sessionId: id,
  scannedAt: 123,
  totalFindings: 1,
  highSeverityCount: 1,
  counts: { "api-key": 1 },
  findings: [
    {
      category: "api-key",
      label: "API key",
      severity: "high",
      source: "command",
      redactedValue: "gh••••8",
      snippet: "echo gh••••8",
      atMs: 3_000,
      occurrences: 1,
    },
  ],
  images: { framesBlurred: 2, regionsBlurred: 3 },
});

test("saveSensitiveReport round-trips through loadSensitiveReport", async () => {
  await withSessionRoot(async (root) => {
    const id = "report-roundtrip";
    await mkdir(path.join(root, id), { recursive: true });
    const report = sampleReport(id);
    saveSensitiveReport(id, report);
    assert.deepEqual(loadSensitiveReport(id), report);
  });
});

test("saveSensitiveReport(undefined) clears a previously written report", async () => {
  await withSessionRoot(async (root) => {
    const id = "report-clear";
    await mkdir(path.join(root, id), { recursive: true });
    saveSensitiveReport(id, sampleReport(id));
    assert.notEqual(loadSensitiveReport(id), null);
    saveSensitiveReport(id, undefined);
    assert.equal(loadSensitiveReport(id), null);
  });
});

test("loadSensitiveReport returns null for missing or malformed files", async () => {
  await withSessionRoot(async (root) => {
    const id = "report-bad";
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    assert.equal(loadSensitiveReport(id), null); // missing
    await writeFile(path.join(dir, "sensitive-report.json"), '{"totalFindings":"nope"}');
    assert.equal(loadSensitiveReport(id), null); // wrong shape
  });
});
