/** Exercises Ralph's descriptor-relative transaction safety and recovery contract. */
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  beginTransaction,
  discardTransaction,
  makeManifest,
  prepareTransaction,
  pointerPath,
  promoteTransaction,
  recoverTransaction,
  transactionDiff,
  verifyTransaction,
} from "../src/transaction.js";
import { atomicWriteRelative } from "../src/safe-fs.js";
import type { RuntimePaths, TransactionJournal } from "../src/types.js";

interface Fixture {
  repo: string;
  metadata: string;
  paths: RuntimePaths;
  close(): void;
}

function fixture(): Fixture {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-ts-repo-")));
  const metadata = realpathSync.native(mkdtempSync(join(homedir(), ".ralph-ts-metadata-")));
  chmodSync(metadata, 0o700);
  mkdirSync(join(repo, ".runtime"), { mode: 0o700 });
  writeFileSync(join(repo, "scoped.txt"), "baseline\n");
  writeFileSync(join(repo, "human.txt"), "human baseline\n");
  const paths: RuntimePaths = {
    packageRoot: repo,
    repoRoot: repo,
    prdFile: join(repo, "prd.json"),
    schemaFile: join(repo, "prd.schema.json"),
    policyFile: join(repo, "INSTRUCTIONS.md"),
    stateDir: join(repo, ".runtime"),
    runLog: join(repo, ".runtime", "run.log"),
    eventLog: join(repo, ".runtime", "events.log"),
  };
  process.env.RALPH_TRANSACTION_METADATA_ROOT = metadata;
  return {
    repo,
    metadata,
    paths,
    close() {
      makeTreeWritable(repo);
      rmSync(repo, { recursive: true, force: true });
      makeTreeWritable(metadata);
      rmSync(metadata, { recursive: true, force: true });
      delete process.env.RALPH_TRANSACTION_METADATA_ROOT;
    },
  };
}

function makeTreeWritable(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeTreeWritable(join(path, name));
}

test("isolates provider edits and detects a concurrent same-path edit", () => {
  const item = fixture();
  try {
    const transaction = beginTransaction(item.paths);
    writeFileSync(join(transaction.workspace, "scoped.txt"), "provider\n");
    writeFileSync(join(item.repo, "human.txt"), "concurrent unrelated\n");
    assert.deepEqual(transactionDiff(item.paths, transaction.journalPath), ["scoped.txt"]);
    prepareTransaction(item.paths, transaction.journalPath);
    assert.deepEqual(verifyTransaction(item.paths, transaction.journalPath), []);
    writeFileSync(join(item.repo, "scoped.txt"), "concurrent same path\n");
    assert.deepEqual(verifyTransaction(item.paths, transaction.journalPath), ["scoped.txt"]);
    discardTransaction(item.paths, transaction.journalPath);
    assert.equal(readFileSync(join(item.repo, "scoped.txt"), "utf8"), "concurrent same path\n");
    assert.equal(readFileSync(join(item.repo, "human.txt"), "utf8"), "concurrent unrelated\n");
  } finally {
    item.close();
  }
});

test("rejects symlinked parents, hard links, and a swapped repository root", () => {
  const item = fixture();
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-ts-outside-")));
  try {
    symlinkSync(outside, join(item.repo, "escape"));
    assert.equal(
      makeManifest(item.repo, item.paths.stateDir).find((entry) => entry.kind === "symlink")?.kind,
      "symlink",
    );
    assert.throws(() => atomicWriteRelative(item.repo, "escape/owned.txt", "blocked\n"));
    assert.throws(() => readFileSync(join(outside, "owned.txt")), /ENOENT/u);
    rmSync(join(item.repo, "escape"));

    linkSync(join(item.repo, "scoped.txt"), join(item.repo, "alias.txt"));
    assert.throws(() => makeManifest(item.repo, item.paths.stateDir), /hard-linked file/u);
    rmSync(join(item.repo, "alias.txt"));

    const transaction = beginTransaction(item.paths);
    const moved = `${item.repo}-moved`;
    renameSync(item.repo, moved);
    mkdirSync(item.repo);
    assert.throws(
      () => prepareTransaction(item.paths, transaction.journalPath),
      /identity changed|ENOENT/u,
    );
    rmSync(item.repo, { recursive: true, force: true });
    renameSync(moved, item.repo);
    discardTransaction(item.paths, transaction.journalPath);
  } finally {
    item.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("recovers a journaled install without changing unrelated live work", () => {
  const item = fixture();
  try {
    const transaction = beginTransaction(item.paths);
    writeFileSync(join(transaction.workspace, "scoped.txt"), "provider result\n");
    prepareTransaction(item.paths, transaction.journalPath);
    const journal = JSON.parse(readFileSync(transaction.journalPath, "utf8")) as TransactionJournal;
    const key = journal.changed[0];
    assert.ok(key);
    const before = journal.baseline.filter((entry) => entry.path === key);
    const after = (journal.prepared ?? []).filter((entry) => entry.path === key);
    mkdirSync(journal.quarantine_root, { recursive: true, mode: 0o700 });
    const quarantine = "interrupted-baseline";
    renameSync(join(item.repo, "scoped.txt"), join(journal.quarantine_root, quarantine));
    writeFileSync(join(item.repo, "scoped.txt"), "provider result\n");
    writeFileSync(join(item.repo, "human.txt"), "human during interruption\n");
    journal.state = "applying";
    journal.promoted = [key];
    journal.evidence = [{ path: key, before, after, quarantine, state: "installed" }];
    writeFileSync(transaction.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

    recoverTransaction(item.paths);
    assert.equal(readFileSync(join(item.repo, "scoped.txt"), "utf8"), "baseline\n");
    assert.equal(readFileSync(join(item.repo, "human.txt"), "utf8"), "human during interruption\n");
    assert.throws(() => readFileSync(transaction.journalPath), /ENOENT/u);
  } finally {
    item.close();
  }
});

test("promotes additions, deletions, mode changes, and entry-kind changes", () => {
  const item = fixture();
  try {
    mkdirSync(join(item.repo, "replace-dir"));
    writeFileSync(join(item.repo, "replace-dir", "child.txt"), "directory\n");
    writeFileSync(join(item.repo, "replace-file"), "file\n");
    mkdirSync(join(item.repo, "delete-dir"));
    writeFileSync(join(item.repo, "delete-dir", "child.txt"), "delete\n");
    symlinkSync("scoped.txt", join(item.repo, "link"));
    const transaction = beginTransaction(item.paths);
    rmSync(join(transaction.workspace, "replace-dir"), { recursive: true });
    symlinkSync("scoped.txt", join(transaction.workspace, "replace-dir"));
    rmSync(join(transaction.workspace, "replace-file"));
    mkdirSync(join(transaction.workspace, "replace-file"));
    writeFileSync(join(transaction.workspace, "replace-file", "child.txt"), "replacement\n");
    chmodSync(join(transaction.workspace, "replace-file"), 0o555);
    rmSync(join(transaction.workspace, "delete-dir"), { recursive: true });
    mkdirSync(join(transaction.workspace, "new-readonly"));
    writeFileSync(join(transaction.workspace, "new-readonly", "child.txt"), "new\n");
    chmodSync(join(transaction.workspace, "new-readonly"), 0o555);
    rmSync(join(transaction.workspace, "link"));
    symlinkSync("human.txt", join(transaction.workspace, "link"));
    prepareTransaction(item.paths, transaction.journalPath);
    promoteTransaction(item.paths, transaction.journalPath);
    assert.equal(readlinkSync(join(item.repo, "replace-dir")), "scoped.txt");
    assert.equal(
      readFileSync(join(item.repo, "replace-file", "child.txt"), "utf8"),
      "replacement\n",
    );
    assert.equal(statSync(join(item.repo, "replace-file")).mode & 0o777, 0o555);
    assert.equal(exists(join(item.repo, "delete-dir")), false);
    assert.equal(statSync(join(item.repo, "new-readonly")).mode & 0o777, 0o555);
    assert.equal(readlinkSync(join(item.repo, "link")), "human.txt");
  } finally {
    item.close();
  }
});

test("rejects linked metadata and escaping journal paths", () => {
  const item = fixture();
  try {
    let transaction = beginTransaction(item.paths);
    const journalBackup = `${transaction.journalPath}.real`;
    renameSync(transaction.journalPath, journalBackup);
    symlinkSync(journalBackup, transaction.journalPath);
    assert.throws(
      () => transactionDiff(item.paths, transaction.journalPath),
      /non-linked regular file/u,
    );
    rmSync(transaction.journalPath);
    renameSync(journalBackup, transaction.journalPath);
    discardTransaction(item.paths, transaction.journalPath);

    transaction = beginTransaction(item.paths);
    const pointer = pointerPath(item.paths);
    const pointerBackup = `${pointer}.real`;
    renameSync(pointer, pointerBackup);
    symlinkSync(pointerBackup, pointer);
    assert.throws(() => recoverTransaction(item.paths), /non-linked regular file/u);
    rmSync(pointer);
    renameSync(pointerBackup, pointer);
    discardTransaction(item.paths, transaction.journalPath);

    transaction = beginTransaction(item.paths);
    const journal = JSON.parse(readFileSync(transaction.journalPath, "utf8")) as TransactionJournal;
    journal.baseline[0] = {
      ...journal.baseline[0]!,
      path: Buffer.from("../escape").toString("base64url"),
    };
    writeFileSync(transaction.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    assert.throws(
      () => transactionDiff(item.paths, transaction.journalPath),
      /escapes the transaction root/u,
    );
  } finally {
    item.close();
  }
});

test("rejects temporary metadata, a replaced mirror, and a pointer rebound to another root", () => {
  const item = fixture();
  const temporaryMetadata = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ralph-provider-metadata-")),
  );
  const previousTmpdir = process.env.TMPDIR;
  try {
    process.env.RALPH_TRANSACTION_METADATA_ROOT = temporaryMetadata;
    assert.throws(() => beginTransaction(item.paths), /provider-writable temp root/u);
    process.env.RALPH_TRANSACTION_METADATA_ROOT = item.metadata;
    const nestedTemporary = join(item.metadata, "provider-temp");
    mkdirSync(nestedTemporary, { mode: 0o700 });
    process.env.TMPDIR = nestedTemporary;
    assert.throws(() => beginTransaction(item.paths), /provider-writable temp root/u);
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;

    let transaction = beginTransaction(item.paths);
    const savedMirror = `${transaction.workspace}.saved`;
    renameSync(transaction.workspace, savedMirror);
    symlinkSync(item.repo, transaction.workspace);
    assert.throws(() => transactionDiff(item.paths, transaction.journalPath));
    rmSync(transaction.workspace);
    renameSync(savedMirror, transaction.workspace);
    discardTransaction(item.paths, transaction.journalPath);

    transaction = beginTransaction(item.paths);
    const pointer = pointerPath(item.paths);
    const original = readFileSync(pointer, "utf8");
    const rebound = JSON.parse(original) as { root: string };
    rebound.root = `${item.repo}-different`;
    writeFileSync(pointer, `${JSON.stringify(rebound)}\n`, { mode: 0o600 });
    assert.throws(() => recoverTransaction(item.paths), /different repository/u);
    writeFileSync(pointer, original, { mode: 0o600 });
    discardTransaction(item.paths, transaction.journalPath);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    item.close();
    rmSync(temporaryMetadata, { recursive: true, force: true });
  }
});

test("keeps journal and baseline outside the provider sandbox boundary", (context) => {
  const available = spawnSync("codex", ["sandbox", "-h"], { stdio: "ignore" });
  if (available.status !== 0) {
    context.skip("codex sandbox unavailable");
    return;
  }
  const item = fixture();
  try {
    const transaction = beginTransaction(item.paths);
    const journal = JSON.parse(readFileSync(transaction.journalPath, "utf8")) as TransactionJournal;
    const baseline = join(journal.baseline_store, "scoped.txt");
    const marker = join(transaction.workspace, "sandbox-probe.log");
    const parentProbe = join(dirname(transaction.workspace), "provider-parent-probe");
    const journalBefore = readFileSync(transaction.journalPath);
    const baselineBefore = readFileSync(baseline);
    const script = `
marker=$1; journal=$2; baseline=$3; parent_probe=$4
printf 'started\\n' >"$marker"
if printf 'poison\\n' >"$journal"; then exit 91; fi
printf 'journal-denied\\n' >>"$marker"
if printf 'poison\\n' >"$baseline"; then exit 92; fi
printf 'baseline-denied\\ncompleted\\n' >>"$marker"
printf 'provider temp write\\n' >"$parent_probe"
`;
    const probe = spawnSync(
      "codex",
      [
        "sandbox",
        "-c",
        "sandbox_workspace_write.writable_roots=[]",
        "-P",
        ":workspace",
        "-C",
        transaction.workspace,
        "/bin/sh",
        "-c",
        script,
        "sandbox-probe",
        marker,
        transaction.journalPath,
        baseline,
        parentProbe,
      ],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assert.equal(readFileSync(transaction.journalPath).equals(journalBefore), true);
    assert.equal(readFileSync(baseline).equals(baselineBefore), true);
    assert.equal(
      readFileSync(marker, "utf8"),
      "started\njournal-denied\nbaseline-denied\ncompleted\n",
    );
    assert.equal(readFileSync(parentProbe, "utf8"), "provider temp write\n");
    discardTransaction(item.paths, transaction.journalPath);
  } finally {
    item.close();
  }
});

test("widens child promotion across a readonly parent and preserves its mode", () => {
  const item = fixture();
  try {
    mkdirSync(join(item.repo, "readonly-parent"));
    writeFileSync(join(item.repo, "readonly-parent", "changed.txt"), "baseline\n");
    writeFileSync(join(item.repo, "readonly-parent", "sibling.txt"), "sibling\n");
    chmodSync(join(item.repo, "readonly-parent"), 0o555);

    let transaction = beginTransaction(item.paths);
    writeFileSync(join(transaction.workspace, "readonly-parent", "changed.txt"), "provider\n");
    prepareTransaction(item.paths, transaction.journalPath);
    writeFileSync(join(item.repo, "readonly-parent", "sibling.txt"), "concurrent sibling\n");
    assert.deepEqual(verifyTransaction(item.paths, transaction.journalPath), ["readonly-parent"]);
    discardTransaction(item.paths, transaction.journalPath);

    writeFileSync(join(item.repo, "readonly-parent", "sibling.txt"), "sibling\n");
    transaction = beginTransaction(item.paths);
    writeFileSync(join(transaction.workspace, "readonly-parent", "changed.txt"), "provider\n");
    prepareTransaction(item.paths, transaction.journalPath);
    promoteTransaction(item.paths, transaction.journalPath);
    assert.equal(
      readFileSync(join(item.repo, "readonly-parent", "changed.txt"), "utf8"),
      "provider\n",
    );
    assert.equal(
      readFileSync(join(item.repo, "readonly-parent", "sibling.txt"), "utf8"),
      "sibling\n",
    );
    assert.equal(statSync(join(item.repo, "readonly-parent")).mode & 0o777, 0o555);
  } finally {
    item.close();
  }
});

test("recovers a readonly directory installed before its journal update", () => {
  const item = fixture();
  try {
    mkdirSync(join(item.repo, "readonly-parent"));
    writeFileSync(join(item.repo, "readonly-parent", "changed.txt"), "baseline\n");
    chmodSync(join(item.repo, "readonly-parent"), 0o555);
    const transaction = beginTransaction(item.paths);
    writeFileSync(join(transaction.workspace, "readonly-parent", "changed.txt"), "provider\n");
    prepareTransaction(item.paths, transaction.journalPath);
    const journal = JSON.parse(readFileSync(transaction.journalPath, "utf8")) as TransactionJournal;
    const key = Buffer.from("readonly-parent").toString("base64url");
    const before = journal.baseline.filter(
      (entry) =>
        entry.path === key ||
        Buffer.from(entry.path, "base64url").toString().startsWith("readonly-parent/"),
    );
    const after = (journal.prepared ?? []).filter(
      (entry) =>
        entry.path === key ||
        Buffer.from(entry.path, "base64url").toString().startsWith("readonly-parent/"),
    );
    const quarantine = ".ralph-interrupted-baseline";
    const rootStat = statSync(item.repo);
    mkdirSync(journal.quarantine_root, { recursive: true, mode: 0o700 });
    journal.state = "applying";
    journal.active = key;
    journal.active_started = true;
    journal.evidence = [
      {
        path: key,
        before,
        after,
        quarantine,
        placement: "sibling",
        parent_identity: { device: rootStat.dev, inode: rootStat.ino },
        state: "quarantined",
      },
    ];
    writeFileSync(transaction.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    renameSync(join(item.repo, "readonly-parent"), join(item.repo, quarantine));
    mkdirSync(join(item.repo, "readonly-parent"));
    writeFileSync(join(item.repo, "readonly-parent", "changed.txt"), "provider\n");
    chmodSync(join(item.repo, "readonly-parent"), 0o555);

    recoverTransaction(item.paths);
    assert.equal(
      readFileSync(join(item.repo, "readonly-parent", "changed.txt"), "utf8"),
      "baseline\n",
    );
    assert.equal(statSync(join(item.repo, "readonly-parent")).mode & 0o777, 0o555);
    assert.equal(exists(join(item.repo, quarantine)), false);
  } finally {
    item.close();
  }
});

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
