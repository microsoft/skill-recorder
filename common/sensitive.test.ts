import assert from "node:assert/strict";
import test from "node:test";

import {
  luhnValid,
  maskValue,
  redactText,
  redactedSnippet,
  resolveOverlaps,
  scanStructuredPii,
  type SensitiveCategory,
  type SensitiveMatch,
} from "./sensitive";

/** Categories present in a structured-PII scan result. */
function categories(text: string): SensitiveCategory[] {
  return scanStructuredPii(text).map((m) => m.category);
}

test("flags emails, valid cards, SSNs, and phone numbers", () => {
  assert.ok(categories("mail me at jane.doe@example.com please").includes("email"));
  // Visa test number (passes Luhn).
  assert.ok(categories("card 4111 1111 1111 1111 expires soon").includes("credit-card"));
  assert.ok(categories("ssn 123-45-6789 on file").includes("ssn"));
  assert.ok(categories("call 415-555-0132 today").includes("phone"));
  assert.ok(categories("ring +1 415 555 0132 now").includes("phone"));
});

test("credit-card detector rejects non-Luhn digit runs and bare numbers", () => {
  assert.ok(!categories("order 4111 1111 1111 1112 shipped").includes("credit-card"));
  assert.ok(!categories("build 1234567890 completed").includes("credit-card"));
});

test("ssn detector rejects invalid area/group/serial", () => {
  assert.ok(!categories("000-45-6789").includes("ssn"));
  assert.ok(!categories("666-45-6789").includes("ssn"));
  assert.ok(!categories("900-45-6789").includes("ssn"));
  assert.ok(!categories("123-00-6789").includes("ssn"));
  assert.ok(!categories("123-45-0000").includes("ssn"));
});

test("phone detector requires grouping and ignores bare digit runs", () => {
  assert.ok(!categories("build 4155550132 completed").includes("phone"));
  assert.ok(!categories("the meeting is at 3pm in room 204").includes("phone"));
});

test("phone after a number ending in 1 is still detected (no country-code latch)", () => {
  // The optional leading "1" country code must not swallow the trailing "1" of a
  // preceding number, which would grow the phone match to overlap that number and
  // get dropped by resolveOverlaps — silently leaking the phone.
  const hits = scanStructuredPii("Noah Kim 345-67-8901 (650) 555-0188");
  assert.deepEqual(
    hits.map((m) => `${m.category}:${m.value}`).sort(),
    ["phone:(650) 555-0188", "ssn:345-67-8901"],
  );
});

test("does not flag ordinary prose, URLs, or commit hashes", () => {
  assert.equal(scanStructuredPii("Opened the quarterly planning doc and reviewed the roadmap.").length, 0);
  assert.equal(scanStructuredPii("Visited https://github.com/microsoft/skill-recorder/issues").length, 0);
  assert.equal(scanStructuredPii("git checkout 9c1e6f2a4b7d8e0f1a2b3c4d5e6f7a8b9c0d1e2f").length, 0);
});

test("overlapping matches collapse to the strongest single finding", () => {
  const higher: SensitiveMatch = {
    category: "api-key",
    label: "GitHub token",
    severity: "high",
    value: "ghp_secretvalue",
    start: 6,
    end: 21,
    rank: 90,
  };
  const lower: SensitiveMatch = {
    category: "password",
    label: "Assignment",
    severity: "medium",
    value: "token=ghp_secretvalue",
    start: 0,
    end: 21,
    rank: 30,
  };
  const kept = resolveOverlaps([lower, higher]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].label, "GitHub token");
});

test("maskValue never returns the original and hides the middle", () => {
  const secret = "ghp_ABCDEFGHIJKLMNOP";
  const masked = maskValue(secret);
  assert.notEqual(masked, secret);
  assert.ok(!masked.includes("CDEFGHIJKLMN"));
  assert.ok(masked.includes("••••"));
  assert.equal(maskValue("short"), "••••");
  assert.equal(maskValue(""), "");
});

test("redactText masks every match in place and leaves the rest intact", () => {
  const text = "email jane@example.com and card 4111 1111 1111 1111 today";
  const matches = scanStructuredPii(text);
  const redacted = redactText(text, matches);
  assert.ok(redacted.startsWith("email "));
  assert.ok(!redacted.includes("jane@example.com"));
  assert.ok(!redacted.includes("4111 1111 1111 1111"));
  assert.ok(redacted.includes("••••"));
});

test("redactedSnippet returns trimmed, masked context", () => {
  const text = "contact the vendor at billing@corp.example.com before the deadline";
  const [match] = scanStructuredPii(text);
  const snippet = redactedSnippet(text, match);
  assert.ok(!snippet.includes("billing@corp.example.com"));
  assert.ok(snippet.includes("••••"));
});

test("redactedSnippet masks a second value adjacent to the focus match", () => {
  // Two emails within one snippet window: the focus match's snippet must not leak
  // the neighbor raw, so callers that pass the full match list stay redacted.
  const text = "primary alice@example.com and backup bob@example.com on file";
  const matches = scanStructuredPii(text);
  assert.equal(matches.length, 2);
  const snippet = redactedSnippet(text, matches[0], matches);
  assert.ok(!snippet.includes("alice@example.com"));
  assert.ok(!snippet.includes("bob@example.com"), "neighbor value must not leak raw");
});

test("Luhn helper behaves", () => {
  assert.ok(luhnValid("4111111111111111"));
  assert.ok(!luhnValid("4111111111111112"));
  assert.ok(!luhnValid("abcd"));
});
