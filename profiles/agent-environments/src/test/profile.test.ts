/** Disposable profile targets cover compatibility, rollback and competing filesystem edits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { install, uninstall } from "../profile.js";

const profile = realpathSync(resolve(import.meta.dirname, "../.."));
async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "rae-profile-ts-")));
  mkdirSync(join(path, "scripts/src"), { recursive: true });
  writeFileSync(join(path, "scripts/src/verify.ts"), "// fixture verifier\n");
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ scripts: { verify: "node scripts/dist/verify.js" } }),
  );
  try {
    await run(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
test("fresh install and uninstall retain manifest-v2 identity and no-op behavior", () =>
  fixture(async (path) => {
    await install(profile, path);
    const manifest = JSON.parse(readFileSync(join(path, ".rae-profile-install.json"), "utf8"));
    assert.equal(manifest.manifest_version, 2);
    assert.equal(manifest.installer, "profiles/agent-environments/installers/install-profile.sh");
    assert.equal(manifest.installed_files.length, 3);
    assert.equal(await uninstall(path), true);
    assert.equal(existsSync(join(path, ".codex/config.toml")), false);
    assert.equal(await uninstall(path), false);
  }));
test("force install preserves original bytes through reinstall and uninstall", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    const original = Buffer.from([0xff, 0xfe, 0x0a]);
    writeFileSync(join(path, ".codex/config.toml"), original);
    await assert.rejects(install(profile, path), /without --force/);
    await install(profile, path, true);
    await install(profile, path, true);
    await uninstall(path);
    assert.deepEqual(readFileSync(join(path, ".codex/config.toml")), original);
  }));
test("modified installed files and tampered backups refuse uninstall before mutation", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    writeFileSync(join(path, ".codex/config.toml"), "original");
    await install(profile, path, true);
    writeFileSync(join(path, ".rae-profile-backups/.codex/config.toml.bak"), "tampered");
    await assert.rejects(uninstall(path), /backup hash mismatch/);
    assert.ok(existsSync(join(path, ".rae-profile-install.json")));
    writeFileSync(join(path, ".codex/config.toml"), "concurrent");
    await assert.rejects(uninstall(path), /missing or modified/);
  }));
test("injected failure restores the pre-install state", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    writeFileSync(join(path, ".codex/config.toml"), "original");
    await assert.rejects(
      install(profile, path, true, (point) => {
        if (point === "install-after-files") throw new Error("injected");
      }),
      /injected/,
    );
    assert.equal(readFileSync(join(path, ".codex/config.toml"), "utf8"), "original");
    assert.equal(existsSync(join(path, ".claude/settings.json")), false);
    assert.equal(existsSync(join(path, ".rae-profile-install.json")), false);
  }));
test("symlinked layout is rejected without outside writes", () =>
  fixture(async (path) => {
    mkdirSync(join(path, "outside"));
    symlinkSync(join(path, "outside"), join(path, ".codex"));
    await assert.rejects(install(profile, path));
    assert.deepEqual(readdirSync(join(path, "outside")), []);
  }));
test("a competing replacement survives rollback with original recovery bytes", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    writeFileSync(join(path, ".codex/config.toml"), "original");
    await assert.rejects(
      install(profile, path, true, (point, relative) => {
        if (point === "install-after-replacement" && relative === ".codex/config.toml") {
          writeFileSync(join(path, ".codex/config.toml"), "competing edit");
          throw new Error("injected");
        }
      }),
      /recovery retained/,
    );
    assert.equal(readFileSync(join(path, ".codex/config.toml"), "utf8"), "competing edit");
    const recovery = readdirSync(path).find((name) => name.startsWith(".rae-profile-recovery-"));
    assert.ok(recovery);
    assert.equal(
      readFileSync(join(path, recovery, "before/.codex/config.toml"), "utf8"),
      "original",
    );
    assert.ok(existsSync(join(path, recovery, "RECOVERY.json")));
  }));
test("parent replacement cannot redirect profile writes and retains recovery", () =>
  fixture(async (path) => {
    mkdirSync(join(path, "outside"));
    await assert.rejects(
      install(profile, path, false, (point, relative) => {
        if (point === "install-after-replacement" && relative === ".codex/config.toml") {
          renameSync(join(path, ".codex"), join(path, "detached"));
          symlinkSync(join(path, "outside"), join(path, ".codex"));
        }
      }),
      /recovery retained/,
    );
    assert.deepEqual(readdirSync(join(path, "outside")), []);
    assert.ok(readdirSync(path).some((name) => name.startsWith(".rae-profile-recovery-")));
  }));

test("concurrent deletion before capture is preserved", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    writeFileSync(join(path, ".codex/config.toml"), "original");
    await assert.rejects(
      install(profile, path, true, (point, relative) => {
        if (point === "install-before-capture" && relative === ".codex/config.toml")
          unlinkSync(join(path, relative));
      }),
      /changed before mutation/,
    );
    assert.equal(existsSync(join(path, ".codex/config.toml")), false);
    assert.equal(existsSync(join(path, ".rae-profile-install.json")), false);
  }));

test("capture-time symlink substitution is restored live without following it", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    writeFileSync(join(path, ".codex/config.toml"), "original");
    writeFileSync(join(path, "outside"), "outside unchanged");
    await assert.rejects(
      install(profile, path, true, (point, relative) => {
        if (point === "install-before-capture" && relative === ".codex/config.toml") {
          unlinkSync(join(path, relative));
          symlinkSync(join(path, "outside"), join(path, relative));
        }
      }),
      /recovery retained/,
    );
    assert.ok(lstatSync(join(path, ".codex/config.toml")).isSymbolicLink());
    assert.equal(readlinkSync(join(path, ".codex/config.toml")), join(path, "outside"));
    assert.equal(readFileSync(join(path, "outside"), "utf8"), "outside unchanged");
  }));

function recoveryQuarantines(path: string): Buffer[] {
  const recovery = readdirSync(path).find((name) => name.startsWith(".rae-profile-recovery-"));
  assert.ok(recovery);
  const root = join(path, recovery, "quarantine");
  function walk(directory: string): Buffer[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(directory, entry.name))
        : [readFileSync(join(directory, entry.name))],
    );
  }
  return walk(root);
}

test("commit alias replacement retains original and installed quarantine evidence", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    writeFileSync(join(path, ".codex/config.toml"), "original");
    await assert.rejects(
      install(profile, path, true, (point, relative) => {
        if (
          point === "install-commit-after-hardlink-before-quarantine-unlink" &&
          relative === ".codex/config.toml"
        ) {
          unlinkSync(join(path, relative));
          writeFileSync(join(path, relative), "competing commit edit");
        }
      }),
      /recovery retained/,
    );
    assert.equal(readFileSync(join(path, ".codex/config.toml"), "utf8"), "competing commit edit");
    const retained = recoveryQuarantines(path);
    assert.ok(retained.some((bytes) => bytes.equals(Buffer.from("original"))));
    assert.ok(
      retained.some((bytes) =>
        bytes.equals(readFileSync(join(profile, "templates/codex/config.toml"))),
      ),
    );
  }));

test("rollback alias replacement preserves original quarantine inode evidence", () =>
  fixture(async (path) => {
    mkdirSync(join(path, ".codex"));
    writeFileSync(join(path, ".codex/config.toml"), "original");
    await assert.rejects(
      install(profile, path, true, (point, relative) => {
        if (point === "install-after-files") throw new Error("injected rollback");
        if (
          point === "rollback-after-hardlink-before-quarantine-unlink" &&
          relative === ".codex/config.toml"
        ) {
          unlinkSync(join(path, relative));
          writeFileSync(join(path, relative), "competing rollback edit");
        }
      }),
      /recovery retained/,
    );
    assert.equal(readFileSync(join(path, ".codex/config.toml"), "utf8"), "competing rollback edit");
    assert.ok(recoveryQuarantines(path).some((bytes) => bytes.equals(Buffer.from("original"))));
  }));

test("legacy targets can recover their receipts but require a Node verifier for new installation", () =>
  fixture(async (path) => {
    await install(profile, path);
    unlinkSync(join(path, "scripts/src/verify.ts"));
    unlinkSync(join(path, "package.json"));
    writeFileSync(join(path, "scripts/verify.sh"), "legacy fixture verifier\n");
    assert.equal(await uninstall(path), true);
    await assert.rejects(install(profile, path), /Node RAE verifier/);
  }));
