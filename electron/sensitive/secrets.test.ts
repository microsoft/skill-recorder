import assert from "node:assert/strict";
import test from "node:test";

import { scanSecrets } from "./secrets";

// Fake, non-real credentials shaped to trip the bundled secretlint preset rules.
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // exactly 36 body chars
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ." +
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

test("detects a GitHub token as a high-severity secret", async () => {
  const matches = await scanSecrets(`run: echo ${GH_TOKEN}`);
  const hit = matches.find((m) => m.value === GH_TOKEN);
  assert.ok(hit, "expected the GitHub token to be detected");
  assert.equal(hit.severity, "high");
  assert.equal(hit.category, "api-key");
  // Offsets point at the raw value in the original text.
  assert.equal(hit.value, `run: echo ${GH_TOKEN}`.slice(hit.start, hit.end));
});

test("detects a JSON Web Token", async () => {
  const matches = await scanSecrets(`Authorization: Bearer ${JWT}`);
  assert.ok(matches.some((m) => m.category === "jwt"), "expected a JWT finding");
});

test("does not flag ordinary prose (no false positives)", async () => {
  const matches = await scanSecrets(
    "Opened the quarterly planning doc, reviewed the roadmap, and closed three issues.",
  );
  assert.deepEqual(matches, []);
});

test("is non-throwing and returns [] for empty input", async () => {
  assert.deepEqual(await scanSecrets(""), []);
});
