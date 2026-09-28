/** Adversarial checks for descriptor anchoring and atomic no-clobber operations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRoot,
  openDirectoryAt,
  openFileAt,
  openLinkedFileAt,
  openParent,
  readDirectory,
  renameAt,
  unlinkAt,
  mkdirAt,
  linkAt,
} from "../index.js";

function fixture(run: (path: string, fd: number) => void): void {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "rae-bridge-")));
  const fd = openRoot(path);
  try {
    run(path, fd);
  } finally {
    closeSync(fd);
    rmSync(path, { recursive: true, force: true });
  }
}

test("rejects non-finite and non-integral numeric native arguments", () =>
  fixture((_path, fd) => {
    for (const invalid of [NaN, Infinity, -Infinity, -1, 0.5, 2 ** 40]) {
      assert.throws(() => readDirectory(invalid), { code: "EINVAL" });
      assert.throws(() => mkdirAt(fd, "invalid", invalid), { code: "EINVAL" });
    }
    assert.deepEqual(readDirectory(fd), []);
  }));

test("rejects symlink components and preserves outside state", () =>
  fixture((path, fd) => {
    mkdirSync(join(path, "outside"));
    symlinkSync(join(path, "outside"), join(path, ".pipeline"));
    assert.throws(() => openDirectoryAt(fd, ".pipeline", true));
    assert.throws(() => openRoot(join(path, ".pipeline")));
    assert.throws(() => openParent(fd, ".pipeline/run/state.json", true));
    const outside = openDirectoryAt(fd, "outside");
    try {
      assert.deepEqual(readDirectory(outside), []);
    } finally {
      closeSync(outside);
    }
  }));

test("held parent descriptors cannot be redirected by a parent swap", () =>
  fixture((path, fd) => {
    mkdirSync(join(path, "outside"));
    const parent = openDirectoryAt(fd, "inside", true);
    try {
      renameSync(join(path, "inside"), join(path, "original"));
      symlinkSync(join(path, "outside"), join(path, "inside"));
      const file = openFileAt(parent, "state", "create");
      writeSync(file, "anchored");
      closeSync(file);
      assert.equal(readFileSync(join(path, "original/state"), "utf8"), "anchored");
      assert.throws(() => readFileSync(join(path, "outside/state")), { code: "ENOENT" });
    } finally {
      closeSync(parent);
    }
  }));

test("rename never clobbers a concurrently created destination", () =>
  fixture((path, fd) => {
    writeFileSync(join(path, "source"), "source");
    writeFileSync(join(path, "target"), "concurrent");
    assert.throws(() => renameAt(fd, "source", fd, "target"), { code: "EEXIST" });
    assert.equal(readFileSync(join(path, "source"), "utf8"), "source");
    assert.equal(readFileSync(join(path, "target"), "utf8"), "concurrent");
    renameAt(fd, "source", fd, "target", false);
    assert.equal(readFileSync(join(path, "target"), "utf8"), "source");
  }));

test("rejects invalid components, symlink files and hardlinks", () =>
  fixture((path, fd) => {
    for (const name of ["", ".", "..", "a/b", "bad\0name"])
      assert.throws(() => openFileAt(fd, name, "create"));
    for (const name of ["", "../state", "a//state", "/state", "a/./state"])
      assert.throws(() => openParent(fd, name, true));
    writeFileSync(join(path, "source"), "source");
    symlinkSync("source", join(path, "symlink"));
    assert.throws(() => openFileAt(fd, "symlink"));
    linkSync(join(path, "source"), join(path, "hardlink"));
    assert.throws(() => openFileAt(fd, "hardlink"), { code: "EINVAL" });
    assert.throws(() => openFileAt(fd, "source"), { code: "EINVAL" });
  }));

test("byte filenames survive enumeration, creation and rename", () =>
  fixture((_path, fd) => {
    // APFS requires Unicode names; Linux filesystems also admit non-UTF-8 bytes.
    const name =
      process.platform === "darwin" ? Buffer.from("byte\tname") : Buffer.from([0xff, 0x61]);
    const file = openFileAt(fd, name, "create");
    assert.equal(fstatSync(file).mode & 0o777, 0o600);
    closeSync(file);
    assert.deepEqual(readDirectory(fd), [name]);
    assert.deepEqual(readDirectory(fd), [name]);
    renameAt(fd, name, fd, "renamed");
    unlinkAt(fd, "renamed");
    assert.deepEqual(readDirectory(fd), []);
  }));

test("transaction hardlink aliases preserve inode and never clobber", () =>
  fixture((path, fd) => {
    writeFileSync(join(path, "original"), "evidence");
    linkAt(fd, "original", fd, "live");
    const source = openLinkedFileAt(fd, "original"),
      live = openLinkedFileAt(fd, "live");
    try {
      assert.equal(fstatSync(source).ino, fstatSync(live).ino);
      assert.equal(fstatSync(live).nlink, 2);
    } finally {
      closeSync(source);
      closeSync(live);
    }
    assert.throws(() => linkAt(fd, "original", fd, "live"), { code: "EEXIST" });
    assert.throws(() => openFileAt(fd, "live"), { code: "EINVAL" });
  }));

test("read-only directory sibling renames preserve mode and no-clobber behavior", () =>
  fixture((path, fd) => {
    mkdirSync(join(path, "source"));
    writeFileSync(join(path, "source/evidence"), "original");
    mkdirSync(join(path, "competing"));
    chmodSync(join(path, "source"), 0o555);
    try {
      assert.throws(() => renameAt(fd, "source", fd, "competing"), { code: "EEXIST" });
      renameAt(fd, "source", fd, "retained");
      const retained = openDirectoryAt(fd, "retained");
      try {
        assert.equal(fstatSync(retained).mode & 0o777, 0o555);
      } finally {
        closeSync(retained);
      }
      assert.equal(readFileSync(join(path, "retained/evidence"), "utf8"), "original");
      renameAt(fd, "retained", fd, "source");
    } finally {
      chmodSync(join(path, "source"), 0o755);
    }
  }));
