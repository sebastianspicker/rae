/** Regression fixtures preserve inert XML, bounded PNG decoding and public metadata gates. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { resolve } from "node:path";
import {
  crc32,
  validateBrandSvg,
  validateSafeSvg,
  validateSocialPreviewPng,
} from "./validate-assets.js";
import {
  obsoletePublicArtifacts,
  requiredFiles,
  validateFrontmatter,
  validateReleaseState,
  validateSourceDensity,
} from "./verify-repository.js";
import { parseVerificationOptions } from "./verify.js";
import { repositoryRoot } from "./repository-files.js";
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Title</title><desc>Description</desc><path d="M0 0"/></svg>';
test("SVG accepts inert accessible geometry and rejects XML or active-content attacks", () => {
  validateBrandSvg(svg, "fixture.svg");
  const attacks = [
    '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + svg,
    svg.replace('<path d="M0 0"/>', "<script>alert(1)</script>"),
    svg.replace('<path d="M0 0"/>', '<image href="https://example.test/image.png"/>'),
    svg.replace('<path d="M0 0"/>', '<path onload="x"/>'),
    svg.replace('<path d="M0 0"/>', '<use href="&#106;avascript:alert(1)"/>'),
    svg.replace(
      '<path d="M0 0"/>',
      '<style><![CDATA[@import "https://example.test/a.css";]]></style>',
    ),
    svg.replace('<path d="M0 0"/>', '<path fill="url(https://example.test)"/>'),
    svg.replace('<path d="M0 0"/>', '<path fill="url(#unterminated"/>'),
    svg.replace("</svg>", "<mismatch></svg>"),
  ];
  for (const attack of attacks) assert.throws(() => validateSafeSvg(attack, "fixture.svg"));
  assert.throws(
    () => validateBrandSvg(svg.replace("<desc>Description</desc>", ""), "fixture.svg"),
    /description/,
  );
  assert.throws(() => validateSafeSvg(" ".repeat(1_000_001) + svg, "fixture.svg"), /large/);
});
function chunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8),
    checksum = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  header.write(type, 4, "ascii");
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), payload])));
  return Buffer.concat([header, payload, checksum]);
}
function png(content: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280);
  header.writeUInt32BE(640, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(content)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("PNG keeps the maintained asset and rejects CRC, truncation, terminal and inflate attacks", () => {
  const asset = readFileSync(resolve(repositoryRoot, "docs/assets/brand/rae-social-preview.png"));
  validateSocialPreviewPng(asset, "preview.png");
  const corrupt = Buffer.from(asset);
  corrupt[25] ^= 1;
  assert.throws(() => validateSocialPreviewPng(corrupt, "preview.png"), /CRC/);
  assert.throws(() => validateSocialPreviewPng(asset.subarray(0, -3), "preview.png"), /truncated/);
  assert.throws(
    () =>
      validateSocialPreviewPng(
        Buffer.concat([asset, chunk("IEND", Buffer.alloc(0))]),
        "preview.png",
      ),
    /non-terminal/,
  );
  assert.throws(
    () => validateSocialPreviewPng(png(Buffer.alloc(9 * 1024 * 1024)), "preview.png"),
    /oversized/,
  );
});
test("metadata and release checks reject missing contracts and dirty candidates", () => {
  validateFrontmatter(
    "---\nstatus: active\nowner: owner\nlast_reviewed: today\nsource_of_truth: source\n---\nText",
    "fixture.md",
  );
  assert.throws(() => validateFrontmatter("No frontmatter", "fixture.md"), /frontmatter/);
  assert.throws(
    () => validateSourceDensity("bibliography.md#src-one", "docs/explanation/research/fixture.md"),
    /minimum/,
  );
  validateSourceDensity(
    Array.from({ length: 7 }, (_, i) => `bibliography.md#src-${i}`).join("\n"),
    "docs/explanation/research/fixture.md",
  );
  assert.deepEqual(obsoletePublicArtifacts(["README.md", "docs/archive/stale.md", "AUDIT.MD"]), [
    "docs/archive/stale.md",
    "AUDIT.MD",
  ]);
  validateReleaseState(Buffer.alloc(0), new Set(requiredFiles));
  assert.throws(
    () => validateReleaseState(Buffer.from(" M package.json\0"), new Set(requiredFiles)),
    /not clean/,
  );
  assert.throws(() => validateReleaseState(Buffer.alloc(0), new Set()), /not tracked/);
});
test("verification retains partial modes and rejects incomplete release modes", () => {
  assert.equal(parseVerificationOptions(["--skip-docs"]).skipDocs, true);
  assert.throws(
    () => parseVerificationOptions(["--release-candidate", "--skip-install"]),
    /partial/,
  );
  assert.throws(() => parseVerificationOptions(["--unknown"]), /Unknown/);
});
