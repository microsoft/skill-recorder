// Pinned, integrity-checked source for the Tesseract `tessdata_fast` language data
// that Advanced protection downloads. Kept free of any electron/runtime imports so it
// can be unit-tested directly. The URL is pinned to an immutable commit (not the
// mutable `main` branch) and every download is verified against a known SHA-256 before
// it is written to disk or handed to the Tesseract WASM parser, so a compromised or
// altered CDN response can never be cached or loaded.

import { createHash } from "node:crypto";

/** The (uncompressed) Tesseract language model filename for a tessdata code. */
export function tessdataFileName(code: string): string {
  return `${code}.traineddata`;
}

/** Immutable `tessdata_fast` commit (tag 4.1.0) the language data is pinned to. Using a
 *  commit SHA instead of `main` makes the fetched bytes reproducible and lets us verify
 *  them against the digests below; bump both together when intentionally upgrading. */
export const TESSDATA_COMMIT = "65727574dfcd264acbb0c3e07860e4e9e9b22185";

/** SHA-256 of each shipped `<code>.traineddata` at {@link TESSDATA_COMMIT}. A download is
 *  rejected unless its bytes match, so altered content is never written or parsed. */
export const TESSDATA_SHA256: Readonly<Record<string, string>> = {
  eng: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
};

/** Pinned raw URL for a language's tessdata file. */
export function tessdataUrl(code: string): string {
  return `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_COMMIT}/${tessdataFileName(code)}`;
}

/** Throw unless `data` hashes (SHA-256) to `expectedHex`. Pure and side-effect free so
 *  both the pass and fail branches are directly unit-testable. */
export function assertSha256(label: string, data: Buffer, expectedHex: string): void {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expectedHex)
    throw new Error(
      `${label} failed its integrity check ` +
        `(expected ${expectedHex.slice(0, 12)}…, got ${actual.slice(0, 12)}…).`,
    );
}

/** Assert downloaded tessdata bytes match the pinned digest. Throws on mismatch or on an
 *  unpinned code (fail closed) so unverifiable data is never used. */
export function verifyTessdata(code: string, data: Buffer): void {
  const expected = TESSDATA_SHA256[code];
  if (!expected)
    throw new Error(`No pinned checksum for OCR language "${code}"; refusing to use it.`);
  assertSha256(`OCR language data for "${code}"`, data, expected);
}
