import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { SensitiveReport } from "../../common/sensitive";
import { buildRedactor, loadSensitiveReport, saveSensitiveReport, scanSession } from "./scanner";

const STARTED_AT = 10_000;

// Fake, non-real values shaped to trip specific detectors.
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // 36 body chars
const CARD = "4111 1111 1111 1111"; // Luhn-valid Visa test number
const EMAIL = "dev@internal.example.com";
const PERSON = "Ada Lovelace";

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
