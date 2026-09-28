/** Cleanup fixtures remain disposable and ensure symlinks cannot expose outside files. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanLocal } from "./clean-local.js";
test("local cleanup preserves Git metadata and outside symlink targets", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "rae-clean-fixture-")));
  try {
    const root = join(temporary, "repo"),
      outside = join(temporary, "outside");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, ".git/keep.tmp"), "git metadata");
    writeFileSync(join(root, "remove.tmp"), "disposable");
    writeFileSync(join(root, "keep.txt"), "retained");
    writeFileSync(join(outside, "keep.tmp"), "outside");
    symlinkSync(outside, join(root, "linked"));
    mkdirSync(join(root, ".ruff_cache"));
    writeFileSync(join(root, ".ruff_cache/data"), "cache");
    symlinkSync(outside, join(root, ".ruff_cache/linked"));
    assert.equal(cleanLocal(root), 2);
    assert.equal(readFileSync(join(outside, "keep.tmp"), "utf8"), "outside");
    assert.ok(existsSync(join(root, ".git/keep.tmp")));
    assert.ok(existsSync(join(root, "keep.txt")));
    assert.ok(!existsSync(join(root, "remove.tmp")));
    assert.ok(!existsSync(join(root, ".ruff_cache")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
