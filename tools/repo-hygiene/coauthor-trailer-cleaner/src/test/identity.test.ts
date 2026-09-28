/** Unicode deduplication preserves the exact first identity used for raw-byte trailer matching. */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTargets } from "../cli.js";
import { caseFold, trimIdentity, identityPattern, emailPattern } from "../identity.js";
import { cleanMessage } from "../objects.js";
test("Unicode full folding retains legacy first-target semantics without rewriting UTF-8 bytes", () => {
  const targets = normalizeTargets([
    { name: " Straße ", email: "PERSON@example.test" },
    { name: "STRASSE", email: "person@example.test" },
  ]);
  assert.deepEqual(targets, [{ name: "Straße", email: "PERSON@example.test" }]);
  const text = Buffer.from(
    "Fixture\nCo-authored-by: Straße <person@example.test>\nCo-authored-by: STRASSE <person@example.test>\n",
  );
  assert.equal(
    cleanMessage(text, targets).toString(),
    "Fixture\nCo-authored-by: STRASSE <person@example.test>\n",
  );
  assert.equal(caseFold("Σςσ ﬃ İ Ꭰꭰ"), "σσσ ffi i\u0307 ᎠᎠ");
});
test("identity whitespace follows the former Python contract including NEL and separators", () => {
  assert.equal(trimIdentity("\u001c\u0085Name\u001f"), "Name");
  assert.equal(trimIdentity("\ufeffName\ufeff"), "\ufeffName\ufeff");
  assert.equal(
    identityPattern.exec("\u0085Name\u0085<a@example.test>\u001c")?.[2],
    "a@example.test",
  );
  assert.equal(emailPattern.test("a\u0085@example.test"), false);
  assert.equal(emailPattern.test("a\ufeff@example.test"), true);
});

test("unpaired surrogate identities fail before raw UTF-8 matching", () => {
  assert.throws(
    () => normalizeTargets([{ name: "\ud800", email: "a@example.test" }]),
    /non-empty string/,
  );
});

test("all Unicode scalar case folds match the Python 3.14 Unicode 16 oracle digest", () => {
  const hash = createHash("sha256");
  for (let code = 0; code < 0x110000; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    hash.update(caseFold(String.fromCodePoint(code)));
    hash.update("\0");
  }
  assert.equal(
    hash.digest("hex"),
    "c657d6f6dd68cbada7e9f6766fde574d34c8b3c3a767f634018b4457168c9cab",
  );
  assert.throws(
    () => normalizeTargets([{ name: "Name", email: "a@example.test\n" }]),
    /Invalid target email/,
  );
});

import { createHash } from "node:crypto";
