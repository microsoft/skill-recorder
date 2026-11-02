import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Tool } from "@github/copilot-sdk";
import { IMPORT_FILE, IMPORT_LIMITS, IMPORT_LIMIT_LABEL, ImportDetailsSchema, ImportMetadataSchema, importSampleOffsets, type ImportMetadata } from "../../common/import";
import { createDescriberTools, type ToolContext } from "../describer/tools";
import { DESCRIBER_INSTRUCTIONS, IMPORTED_DESCRIBER_INSTRUCTIONS } from "../describer/instructions";
import { scanSession, buildRedactor } from "../sensitive/scanner";
import { listSessions, deleteSession } from "../sessions";
import { ImportManager } from "./manager";
import { readImport, readSessionImport, writeImportJson } from "./metadata";
import { inspectImportTracks } from "./tracks";
import { WITHHOLD_FRAME_REDACTOR } from "../sensitive/frame-redact";

const imported: ImportMetadata = {
  version: 1, file: "import.mp4", name: "Meeting.mp4", importedAt: 10000,
  bytes: 100, durationMs: 2000, width: 640, height: 360, hasAudio: true,
  details: "", language: "en",
};

function box(id: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(id, 4, "ascii");
  return Buffer.concat([header, body]);
}

function mp4(video = "avc1", audio: string | null = "mp4a", channels = 2): Buffer {
  const track = (type: string, codec: string) => {
    const handler = Buffer.alloc(12);
    handler.write(type, 8, "ascii");
    const entry = Buffer.alloc(28);
    entry.writeUInt16BE(channels, 16);
    entry.writeUInt32BE(48000 * 65536, 24);
    const description = Buffer.alloc(8);
    description.writeUInt32BE(1, 4);
    return box("trak", box("mdia", box("hdlr", handler),
      box("minf", box("stbl", box("stsd", description, box(codec, entry))))));
  };
  return Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", track("vide", video), ...(audio ? [track("soun", audio)] : []))]);
}

function element(id: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  assert.ok(body.length < 127);
  return Buffer.concat([Buffer.from(id, "hex"), Buffer.from([body.length | 128]), body]);
}

function webm(audio = "A_OPUS"): Buffer {
  const rate = Buffer.alloc(4);
  rate.writeFloatBE(48000);
  return Buffer.concat([
    element("1a45dfa3", element("4282", Buffer.from("webm"))),
    element("18538067", element("1654ae6b",
      element("ae", element("83", Buffer.from([1])), element("86", Buffer.from("V_VP8"))),
      element("ae", element("83", Buffer.from([2])), element("86", Buffer.from(audio)),
        element("e1", element("9f", Buffer.from([2])), element("b5", rate))))),
  ]);
}

test("import metadata enforces exact limits, source paths, and optional blank details", () => {
  assert.equal(IMPORT_LIMITS.bytes, 512 * 1024 * 1024);
  assert.match(IMPORT_LIMIT_LABEL, /512 MiB/);
  assert.ok(ImportMetadataSchema.safeParse({ ...imported, bytes: 129 * 1024 * 1024 }).success);
  assert.ok(ImportDetailsSchema.safeParse({ details: "", language: "en" }).success);
  assert.ok(ImportMetadataSchema.safeParse({ ...imported, bytes: IMPORT_LIMITS.bytes, durationMs: IMPORT_LIMITS.durationMs }).success);
  for (const patch of [
    { bytes: IMPORT_LIMITS.bytes + 1 }, { durationMs: IMPORT_LIMITS.durationMs + 1 },
    { durationMs: Infinity }, { file: "..\\outside.mp4" }, { language: "unsupported" },
    { width: 100000 }, { details: "x".repeat(IMPORT_LIMITS.details + 1) },
  ]) assert.equal(ImportMetadataSchema.safeParse({ ...imported, ...patch }).success, false);
});

test("overview samples cover the entire recording without front-loading the budget", () => {
  const samples = importSampleOffsets(IMPORT_LIMITS.durationMs, 24);
  assert.equal(samples.length, 24);
  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), IMPORT_LIMITS.durationMs - 100);
  assert.ok(samples.every((value, index) => !index || value > samples[index - 1]));
  assert.deepEqual(importSampleOffsets(20, 1), [0]);
  assert.throws(() => importSampleOffsets(NaN, 2));
  assert.throws(() => importSampleOffsets(1000, 0));
});

test("MP4 track inspection distinguishes no audio and rejects unknown/encrypted codecs", () => {
  assert.deepEqual(inspectImportTracks(mp4(), ".mp4"), { hasAudio: true });
  assert.deepEqual(inspectImportTracks(mp4("avc1", null), ".mp4"), { hasAudio: false });
  for (const fixture of [mp4("zzzz"), mp4("avc1", "zzzz"), mp4("avc1", "enca"), mp4("avc1", "mp4a", 6)]) {
    assert.throws(() => inspectImportTracks(fixture, ".mp4"));
  }
  assert.throws(() => inspectImportTracks(mp4().subarray(0, 30), ".mp4"));
  assert.throws(() => inspectImportTracks(mp4(), ".webm"));
});

test("WebM track inspection validates codec identity and bounds", () => {
  assert.deepEqual(inspectImportTracks(webm(), ".webm"), { hasAudio: true });
  assert.throws(() => inspectImportTracks(webm("A_BAD"), ".webm"));
  for (const fixture of [Buffer.alloc(10), webm().subarray(0, 15), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])]) {
    assert.throws(() => inspectImportTracks(fixture, ".webm"));
  }
});

async function invoke(tools: Tool[], name: string, args: unknown = {}): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool?.handler);
  return tool.handler(args, { sessionId: "test", toolCallId: "test", toolName: name, arguments: args });
}

test("import tools expose protected context, not fabricated events, and require viewed images", async () => {
  let submissions = 0;
  const context: ToolContext = {
    sessionDir: tmpdir(), startedAt: imported.importedAt, extractor: null,
    imported: { ...imported, details: "Demo 00:01-00:02. secret@example.com" },
    redaction: { current: { redactText: (text) => text.replaceAll("secret@example.com", "[EMAIL]"), frameRedactor: null } },
    onSubmit: () => { submissions++; },
  };
  const tools = createDescriberTools(context);
  assert.deepEqual(tools.map((tool) => tool.name), ["get_timeline", "list_frames", "get_frames", "get_narration", "submit_analysis"]);
  const timeline = await invoke(tools, "get_timeline");
  assert.equal(typeof timeline, "string");
  const parsed = JSON.parse(String(timeline));
  assert.equal(parsed.durationMs, imported.durationMs);
  assert.deepEqual(parsed.steps, []);
  assert.match(parsed.additionalDetails, /\[EMAIL\]/);
  assert.doesNotMatch(String(timeline), /secret@example.com/);
  assert.match(JSON.stringify(await invoke(tools, "submit_analysis", { intent: "Task", steps: [] })), /Inspect actual video images/);
  assert.equal(submissions, 0);
  const normal = createDescriberTools({ ...context, imported: undefined });
  assert.ok(normal.some((tool) => tool.name === "get_events"));
  assert.ok(normal.some((tool) => tool.name === "search_terminal_output"));
  assert.match(DESCRIBER_INSTRUCTIONS, /OS events as the PRIMARY source/);
  assert.match(IMPORTED_DESCRIBER_INSTRUCTIONS, /NO captured OS events/);
});

test("import jobs reject duplicate work and remain busy until cancellation settles", async () => {
  const manager = new ImportManager();
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const job = manager.run("test", async (current) => {
    signal = current;
    await new Promise<void>((resolve) => { release = resolve; });
    current.throwIfAborted();
  });
  assert.equal(manager.isBusy("test"), true);
  await assert.rejects(manager.run("test", async () => undefined), /already/);
  manager.cancel("test");
  assert.equal(signal?.aborted, true);
  assert.equal(manager.isBusy("test"), true);
  release();
  await assert.rejects(job);
  await manager.whenIdle();
  assert.equal(manager.isBusy("test"), false);
});

test("import analysis uses the normal result schema only after protected images were served", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-recorder-import-tools-"));
  try {
    await mkdir(path.join(dir, "frames"));
    await writeFile(path.join(dir, "frames", "test.jpg"), Buffer.from([255, 216, 255, 217]));
    const frame = { file: "test.jpg", tMs: imported.importedAt + 1000, offsetSec: 1, source: "probe" as const, phash: "" };
    const holder: { value?: unknown } = {};
    const context: ToolContext = {
      sessionDir: dir, startedAt: imported.importedAt, imported,
      extractor: { manifest: [frame], extractWindow: async () => [frame] },
      redaction: { current: { redactText: (text) => text, frameRedactor: WITHHOLD_FRAME_REDACTOR } },
      onSubmit: (value) => { holder.value = value; },
    };
    const tools = createDescriberTools(context);
    const submission = {
      title: "Approve Expense", intent: "Approve an expense.",
      steps: [{ id: "s1", title: "Opened expense", detail: "Opened the demonstrated form." }],
    };
    await invoke(tools, "get_frames", { fromMs: 900, toMs: 1500 });
    await invoke(tools, "submit_analysis", submission);
    assert.equal(holder.value, undefined, "withheld images are not visual evidence");
    context.redaction.current = { redactText: (text) => text, frameRedactor: null };
    const shown = await invoke(tools, "get_frames", { fromMs: 900, toMs: 1500 });
    assert.match(JSON.stringify(shown), /binaryResultsForLlm/);
    await invoke(tools, "submit_analysis", submission);
    assert.deepEqual(holder.value, {
      ...submission, intentConfidence: "medium", intentRationale: "",
      steps: [{ ...submission.steps[0], apps: [], evidence: [], confidence: "medium" }],
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("import details persist, are scanned, invalidate changed-language transcripts, and preserve legacy sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-import-unit-"));
  const previous = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  try {
    const dir = path.join(root, "import-test");
    await mkdir(dir);
    await writeImportJson(dir, IMPORT_FILE, imported);
    await writeImportJson(dir, "session.json", { id: "import-test", startedAt: 10000, stoppedAt: 12000, source: "imported-video" });
    await writeFile(path.join(dir, "events.jsonl"), "");
    await writeFile(path.join(dir, "narration.json"), JSON.stringify({ model: "test", segments: [] }));
    const manager = new ImportManager();
    await manager.saveDetails("import-test", { details: "Contact person@example.com. Demo 00:01-00:02.", language: "it" });
    assert.equal(readImport(dir)?.language, "it");
    await assert.rejects(readFile(path.join(dir, "narration.json")), { code: "ENOENT" });
    const { values } = await scanSession("import-test");
    const redacted = buildRedactor(values)(readImport(dir)!.details);
    assert.doesNotMatch(redacted, /person@example.com/);
    assert.match(redacted, /00:01-00:02/);
    const legacy = path.join(root, "legacy-test");
    await mkdir(legacy);
    await writeImportJson(legacy, "session.json", { id: "legacy-test", startedAt: 1000, stoppedAt: 2000 });
    await writeImportJson(legacy, IMPORT_FILE, imported);
    assert.equal(readSessionImport(legacy), null, "only an explicit source discriminator enables import behavior");
    const sessions = await listSessions();
    assert.equal(sessions.find((session) => session.id === "legacy-test")?.imported, undefined);
    assert.equal(sessions.find((session) => session.id === "import-test")?.imported?.details, readImport(dir)?.details);
    await deleteSession("import-test");
    assert.equal((await listSessions()).length, 1);
  } finally {
    if (previous === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
