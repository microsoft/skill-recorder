import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  assertSha256,
  TESSDATA_COMMIT,
  TESSDATA_SHA256,
  tessdataFileName,
  tessdataUrl,
  verifyTessdata,
} from "./tessdata-source";

test("tessdataUrl pins an immutable commit, never the mutable main branch", () => {
  const url = tessdataUrl("eng");
  assert.match(url, /tessdata_fast\/[0-9a-f]{40}\/eng\.traineddata$/);
  assert.ok(url.includes(TESSDATA_COMMIT));
  assert.ok(!url.includes("/main/"), "URL must not track the mutable main branch");
});

test("tessdataFileName maps a code to its .traineddata file", () => {
  assert.equal(tessdataFileName("eng"), "eng.traineddata");
});

test("the pinned eng digest is a 64-char hex SHA-256", () => {
  assert.match(TESSDATA_SHA256.eng, /^[0-9a-f]{64}$/);
});

test("assertSha256 passes when the bytes hash to the expected digest", () => {
  const data = Buffer.from("hello tessdata");
  const digest = createHash("sha256").update(data).digest("hex");
  assert.doesNotThrow(() => assertSha256("test data", data, digest));
});

test("assertSha256 throws when the bytes do not hash to the expected digest", () => {
  const data = Buffer.from("hello tessdata");
  const wrong = createHash("sha256").update("something else").digest("hex");
  assert.throws(() => assertSha256("test data", data, wrong), /failed its integrity check/);
});

test("verifyTessdata throws when the downloaded bytes do not match the pinned digest", () => {
  assert.throws(
    () => verifyTessdata("eng", Buffer.from("tampered content")),
    /failed its integrity check/,
  );
});

test("verifyTessdata fails closed for a language with no pinned checksum", () => {
  assert.throws(() => verifyTessdata("zzz", Buffer.from("anything")), /No pinned checksum/);
});
