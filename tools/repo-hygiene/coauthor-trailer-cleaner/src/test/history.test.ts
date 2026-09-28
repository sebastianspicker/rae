/** Disposable object/ref fixtures exercise byte preservation, topology and recovery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, rewriteRepository, type RewriteOptions } from "../git.js";
import { transformCommit } from "../objects.js";

const targets = [{ name: "Pair Bot", email: "pair@example.test" }];
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const options: RewriteOptions = {
  targets,
  dryRun: false,
  validateOnly: false,
  noPush: true,
  backupRemote: "",
};
function fixture(run: (path: string) => void): void {
  const path = mkdtempSync(join(tmpdir(), "rae-history-ts-"));
  try {
    git(path, ["init", "-b", "main"]);
    git(path, ["config", "user.name", "Fixture Maintainer"]);
    git(path, ["config", "user.email", "maintainer@example.test"]);
    git(path, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(path, "evidence.txt"), "immutable tree\n");
    git(path, ["add", "evidence.txt"]);
    git(path, ["commit", "-m", "Fixture\n\nCo-authored-by: Pair Bot <pair@example.test>"]);
    run(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
function text(path: string, ...args: string[]): string {
  return git(path, args).toString("utf8").trim();
}

function switchHeadAt(transaction: number, run: () => void): void {
  const shim = mkdtempSync(join(tmpdir(), "rae-git-interposer-"));
  const keys = ["PATH", "RAE_TEST_REAL_GIT", "RAE_TEST_REF_MARKER", "RAE_TEST_SWITCH_AT"];
  const prior = keys.map((key) => process.env[key]);
  try {
    const realGit = (process.env.PATH ?? "")
      .split(":")
      .map((directory) => join(directory, "git"))
      .find((path) => existsSync(path));
    assert.ok(realGit, "Git must be available");
    copyFileSync(new URL("./git-shim.js", import.meta.url), join(shim, "git"));
    chmodSync(join(shim, "git"), 0o700);
    process.env.RAE_TEST_REAL_GIT = realGit;
    process.env.RAE_TEST_REF_MARKER = join(shim, "transactions");
    process.env.RAE_TEST_SWITCH_AT = String(transaction);
    process.env.PATH = `${shim}:${process.env.PATH ?? ""}`;
    run();
  } finally {
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
    rmSync(shim, { recursive: true, force: true });
  }
}

for (const [phase, transaction] of [
  ["promotion", 2],
  ["cleanup", 3],
] as const) {
  test(`HEAD switch during ${phase} atomically refuses ref changes and retains recovery`, () =>
    fixture((path) => {
      const original = text(path, "rev-parse", "HEAD");
      git(path, ["branch", "other"]);
      switchHeadAt(transaction, () => {
        assert.throws(
          () => rewriteRepository({ url: "git@github.com:acme/demo", path }, options),
          /update-ref failed/,
        );
      });
      assert.equal(text(path, "symbolic-ref", "HEAD"), "refs/heads/other");
      assert.equal(text(path, "rev-parse", "other"), original);
      const main = text(path, "rev-parse", "main");
      if (phase === "promotion") assert.equal(main, original);
      else assert.notEqual(main, original);
      assert.equal(
        text(path, "for-each-ref", "--format=%(objectname)", "refs/heads/backup"),
        original,
      );
      assert.equal(
        text(path, "for-each-ref", "--format=%(objectname)", "refs/coauthor-trailer-cleaner"),
        main,
      );
    }));
}

test("local rewrite preserves trees and unrelated refs and cleans transaction refs", () =>
  fixture((path) => {
    const original = text(path, "rev-parse", "HEAD"),
      tree = text(path, "rev-parse", "HEAD^{tree}");
    git(path, ["branch", "unrelated"]);
    git(path, ["tag", "untouched"]);
    const result = rewriteRepository({ url: "git@github.com:acme/demo", path }, options);
    assert.notEqual(result.rewritten, original);
    assert.equal(text(path, "rev-parse", "HEAD^{tree}"), tree);
    assert.equal(text(path, "rev-parse", "unrelated"), original);
    assert.equal(text(path, "rev-parse", "untouched"), original);
    assert.equal(text(path, "log", "-1", "--format=%B"), "Fixture");
    assert.equal(
      text(
        path,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/backup",
        "refs/coauthor-trailer-cleaner",
      ),
      "",
    );
  }));

test("dirty and dry-run modes never create recovery refs or move HEAD", () =>
  fixture((path) => {
    const original = text(path, "rev-parse", "HEAD");
    writeFileSync(join(path, "evidence.txt"), "concurrent change\n");
    assert.throws(
      () => rewriteRepository({ url: "https://github.com/acme/demo", path }, options),
      /clean/,
    );
    rewriteRepository({ url: "https://github.com/acme/demo", path }, { ...options, dryRun: true });
    assert.equal(text(path, "rev-parse", "HEAD"), original);
    assert.equal(text(path, "for-each-ref", "--format=%(refname)", "refs/heads/backup"), "");
  }));

test("raw headers, non-UTF8 messages and ordered merge parents survive transformation", () => {
  const raw = Buffer.from(
    "tree " +
      "1".repeat(40) +
      "\nparent " +
      "2".repeat(40) +
      "\nparent " +
      "3".repeat(40) +
      "\nauthor Name <n@example.test> 123 +0130\ncommitter Other <o@example.test> 456 -0230\nencoding ISO-8859-1\nx-extra value\n continuation\ngpgsig -----BEGIN SIGNATURE-----\n stale\n -----END SIGNATURE-----\n\n\xff\xfe message\n\nCo-authored-by: Pair Bot <pair@example.test>\n",
    "latin1",
  );
  const result = transformCommit(
    raw,
    new Map([
      ["2".repeat(40), "4".repeat(40)],
      ["3".repeat(40), "5".repeat(40)],
    ]),
    targets,
  );
  assert.equal(result.invalidatedSignatures, 1);
  assert.ok(result.bytes.includes(Buffer.from("\xff\xfe message", "latin1")));
  assert.ok(
    result.bytes.includes(Buffer.from("parent " + "4".repeat(40) + "\nparent " + "5".repeat(40))),
  );
  assert.ok(
    result.bytes.includes(Buffer.from("encoding ISO-8859-1\nx-extra value\n continuation")),
  );
  assert.ok(!result.bytes.includes(Buffer.from("gpgsig")));
  assert.ok(!result.bytes.includes(Buffer.from("Co-authored-by")));
});

test("merge parent topology and every tree remain equivalent", () =>
  fixture((path) => {
    const original = text(path, "rev-parse", "HEAD");
    git(path, ["checkout", "-b", "side"]);
    writeFileSync(join(path, "side.txt"), "side");
    git(path, ["add", "."]);
    git(path, ["commit", "-m", "Side"]);
    git(path, ["checkout", "main"]);
    writeFileSync(join(path, "main.txt"), "main");
    git(path, ["add", "."]);
    git(path, ["commit", "-m", "Main"]);
    git(path, ["merge", "--no-ff", "side", "-m", "Merge"]);
    const before = text(path, "rev-list", "--reverse", "--topo-order", "HEAD").split("\n");
    const oldTrees = before.map((commit) => text(path, "rev-parse", `${commit}^{tree}`));
    rewriteRepository({ url: "https://github.com/acme/demo", path }, options);
    const after = text(path, "rev-list", "--reverse", "--topo-order", "HEAD").split("\n");
    assert.equal(after.length, before.length);
    assert.deepEqual(
      after.map((commit) => text(path, "rev-parse", `${commit}^{tree}`)),
      oldTrees,
    );
    const mapping = new Map(before.map((commit, index) => [commit, after[index]]));
    for (let index = 0; index < before.length; index++) {
      const oldParents = text(path, "show", "-s", "--format=%P", before[index])
        .split(" ")
        .filter(Boolean);
      const newParents = text(path, "show", "-s", "--format=%P", after[index])
        .split(" ")
        .filter(Boolean);
      assert.deepEqual(
        newParents,
        oldParents.map((parent) => mapping.get(parent)),
      );
    }
    assert.notEqual(after[0], original);
  }));

function withBare(path: string, run: (bare: string) => void): void {
  const bare = join(path, "..", `bare-${path.split("/").pop()}.git`);
  const transport = join(path, "..", `transport-${path.split("/").pop()}.mjs`);
  const keys = ["GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "RAE_FIXTURE_BARE", "GIT_ALLOW_PROTOCOL"];
  const prior = keys.map((key) => process.env[key]);
  try {
    git(path, ["init", "--bare", bare]);
    copyFileSync(new URL("./local-transport.js", import.meta.url), transport);
    process.env.GIT_SSH_COMMAND = `"${process.execPath}" "${transport}"`;
    process.env.GIT_SSH_VARIANT = "ssh";
    process.env.GIT_ALLOW_PROTOCOL = "ssh:file";
    process.env.RAE_FIXTURE_BARE = bare;
    git(path, ["remote", "add", "origin", "git@github.com:acme/demo"]);
    git(path, ["push", "-u", "origin", "main"]);
    run(bare);
  } finally {
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
    rmSync(bare, { recursive: true, force: true });
    rmSync(transport, { force: true });
  }
}

test("leased push updates only the intended local-bare branch", () =>
  fixture((path) =>
    withBare(path, (bare) => {
      const result = rewriteRepository(
        { url: "git@github.com:acme/demo", path },
        { ...options, noPush: false },
      );
      assert.equal(text(bare, "rev-parse", "main"), result.rewritten);
      assert.equal(text(path, "rev-parse", "HEAD"), result.rewritten);
    }),
  ));

test("rejected push rolls back by exact OID and retains both recovery refs", () =>
  fixture((path) =>
    withBare(path, (bare) => {
      const original = text(path, "rev-parse", "HEAD");
      git(bare, ["config", "receive.denyNonFastForwards", "true"]);
      assert.throws(
        () =>
          rewriteRepository(
            { url: "git@github.com:acme/demo", path },
            { ...options, noPush: false },
          ),
        /Push failed; restored/,
      );
      assert.equal(text(path, "rev-parse", "HEAD"), original);
      assert.equal(text(bare, "rev-parse", "main"), original);
      assert.equal(
        text(path, "for-each-ref", "--format=%(objectname)", "refs/heads/backup"),
        original,
      );
      assert.notEqual(
        text(path, "for-each-ref", "--format=%(objectname)", "refs/coauthor-trailer-cleaner"),
        "",
      );
    }),
  ));

test("HEAD switch during rejected-push rollback leaves both branches and recovery intact", () =>
  fixture((path) =>
    withBare(path, (bare) => {
      const original = text(path, "rev-parse", "HEAD");
      git(path, ["branch", "other"]);
      git(bare, ["config", "receive.denyNonFastForwards", "true"]);
      switchHeadAt(4, () => {
        assert.throws(
          () =>
            rewriteRepository(
              { url: "git@github.com:acme/demo", path },
              { ...options, noPush: false },
            ),
          /update-ref failed/,
        );
      });
      assert.equal(text(path, "symbolic-ref", "HEAD"), "refs/heads/other");
      assert.equal(text(path, "rev-parse", "other"), original);
      assert.equal(text(bare, "rev-parse", "main"), original);
      const rewritten = text(path, "rev-parse", "main");
      assert.notEqual(rewritten, original);
      assert.equal(
        text(path, "for-each-ref", "--format=%(objectname)", "refs/heads/backup"),
        original,
      );
      assert.equal(
        text(path, "for-each-ref", "--format=%(objectname)", "refs/coauthor-trailer-cleaner"),
        rewritten,
      );
    }),
  ));

test("existing reference-transaction hooks receive the guarded phases and ref input", () =>
  fixture((path) => {
    const hook = join(path, ".git/hooks/reference-transaction"),
      log = join(path, ".git/reference-fixture.jsonl");
    copyFileSync(new URL("./reference-hook.js", import.meta.url), hook);
    chmodSync(hook, 0o700);
    const prior = process.env.RAE_TEST_HOOK_LOG;
    try {
      process.env.RAE_TEST_HOOK_LOG = log;
      rewriteRepository({ url: "git@github.com:acme/demo", path }, options);
      const events = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { phase: string; input: string });
      assert.equal(events.filter((event) => event.phase === "prepared").length, 4);
      assert.equal(events.filter((event) => event.phase === "committed").length, 3);
      assert.ok(events.some((event) => event.phase === "aborted"));
      assert.ok(
        events
          .filter((event) => event.phase === "prepared")
          .every((event) => event.input.includes("refs/heads/main")),
      );
    } finally {
      if (prior === undefined) delete process.env.RAE_TEST_HOOK_LOG;
      else process.env.RAE_TEST_HOOK_LOG = prior;
    }
  }));

test("missing Git guard capability fails before creating recovery or changing branches", () =>
  fixture((path) => {
    const original = text(path, "rev-parse", "HEAD");
    const prior = process.env.RAE_TEST_DISABLE_HOOKS;
    try {
      process.env.RAE_TEST_DISABLE_HOOKS = "1";
      switchHeadAt(99, () =>
        assert.throws(
          () => rewriteRepository({ url: "git@github.com:acme/demo", path }, options),
          /guards are unavailable/,
        ),
      );
    } finally {
      if (prior === undefined) delete process.env.RAE_TEST_DISABLE_HOOKS;
      else process.env.RAE_TEST_DISABLE_HOOKS = prior;
    }
    assert.equal(text(path, "rev-parse", "HEAD"), original);
    assert.equal(
      text(
        path,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/backup",
        "refs/coauthor-trailer-cleaner",
      ),
      "",
    );
  }));
