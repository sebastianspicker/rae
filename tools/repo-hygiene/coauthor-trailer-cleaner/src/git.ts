/** Exact-OID history transactions; no checkout resets or wildcard ref mutation. */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cleanMessage, transformCommit, type Target } from "./objects.js";

export interface Repository {
  url: string;
  path: string;
}
export interface RewriteOptions {
  targets: readonly Target[];
  dryRun: boolean;
  validateOnly: boolean;
  noPush: boolean;
  backupRemote: string;
}
export interface RewriteResult {
  original: string;
  rewritten: string;
  commits: number;
  invalidatedSignatures: number;
  recoveryRef?: string;
}
export function githubIdentity(url: string): string {
  const match = url
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .match(
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+)$/,
    );
  if (!match) throw new Error(`Unsupported GitHub URL: ${url}`);
  return `${match[1]}/${match[2]}`;
}
export function git(
  path: string,
  args: readonly string[],
  input?: Buffer | string,
  overrides: NodeJS.ProcessEnv = {},
): Buffer {
  const environment = {
    ...process.env,
    ...overrides,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
  ])
    delete environment[key as keyof typeof environment];
  const child = spawnSync("git", ["-C", path, ...args], {
    input,
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(
      `git ${args.includes("update-ref") ? "update-ref" : args[0]} failed: ${child.stderr.toString("utf8").slice(-4096)}`,
    );
  return child.stdout;
}
function text(path: string, ...args: string[]): string {
  return git(path, args).toString("utf8").trim();
}
function oid(path: string, ref: string): string {
  return text(path, "rev-parse", "--verify", `${ref}^{commit}`);
}
function clean(path: string): boolean {
  return git(path, ["status", "--porcelain", "--untracked-files=all"]).length === 0;
}
function referenceTransactions(
  path: string,
  branch: string,
  expected: string,
): { update: (commands: string[]) => void; close: () => void } {
  const head = text(path, "rev-parse", "--path-format=absolute", "--git-path", "HEAD");
  const existingHook = text(
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks/reference-transaction",
  );
  let original = "";
  try {
    accessSync(existingHook, constants.X_OK);
    original = existingHook;
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["ENOENT", "EACCES"].includes(String(error.code))
    )
      throw error;
  }
  const directory = mkdtempSync(join(tmpdir(), "rae-history-ref-guard-"));
  try {
    chmodSync(directory, 0o700);
    const hook = join(directory, "reference-transaction");
    copyFileSync(new URL("./ref-guard.js", import.meta.url), hook);
    chmodSync(hook, 0o700);
    const receipt = join(directory, "prepared");
    const environment = {
      RAE_HISTORY_HEAD_PATH: head,
      RAE_HISTORY_BRANCH: branch,
      RAE_HISTORY_REFERENCE_HOOK: original,
      RAE_HISTORY_PREPARED_RECEIPT: receipt,
    };
    // Prove the installed Git invokes the guard before any ref mutation. Older
    // implementations that ignore this hook cannot silently bypass protection.
    git(
      path,
      ["-c", `core.hooksPath=${directory}`, "update-ref", "--stdin", "--no-deref"],
      ["start", `verify ${branch} ${expected}`, "prepare", "abort", ""].join("\n"),
      environment,
    );
    if (!existsSync(receipt))
      throw new Error("Git reference-transaction guards are unavailable; refusing rewrite");
    return {
      update(commands) {
        git(
          path,
          ["-c", `core.hooksPath=${directory}`, "update-ref", "--stdin", "--no-deref"],
          ["start", ...commands, "prepare", "commit", ""].join("\n"),
          {
            ...environment,
          },
        );
      },
      close() {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
function tree(path: string, commit: string): string {
  return text(path, "rev-parse", `${commit}^{tree}`);
}

export function rewriteRepository(repository: Repository, options: RewriteOptions): RewriteResult {
  githubIdentity(repository.url);
  const path = repository.path;
  if (!isAbsolute(path)) throw new Error("Local repository path must be absolute");
  if (text(path, "rev-parse", "--is-inside-work-tree") !== "true")
    throw new Error("A worktree is required");
  if (text(path, "rev-parse", "--is-shallow-repository") !== "false")
    throw new Error("Shallow history is unsupported");
  if (existsSync(text(path, "rev-parse", "--path-format=absolute", "--git-path", "info/grafts")))
    throw new Error("Grafted history is unsupported");
  const branch = text(path, "symbolic-ref", "--quiet", "HEAD");
  const original = oid(path, branch);
  if (!options.validateOnly && !options.dryRun && !clean(path))
    throw new Error("Repository worktree must be clean before rewrite");
  let upstreamRemote = "",
    upstreamRef = "",
    expectedUpstream = "";
  if (!options.noPush) {
    [upstreamRemote, upstreamRef] = text(
      path,
      "for-each-ref",
      "--format=%(upstream:remotename)%09%(upstream:remoteref)",
      branch,
    ).split("\t");
    if (!upstreamRemote || !upstreamRef?.startsWith("refs/heads/"))
      throw new Error("Current branch must track a remote branch");
    expectedUpstream = oid(path, "@{upstream}");
    if (expectedUpstream !== original)
      throw new Error("Branch must be in sync with upstream before push rewrite");
    const matching = text(path, "remote")
      .split("\n")
      .filter((remote) => {
        const urls = text(path, "remote", "get-url", "--all", remote).split("\n");
        return urls.some((url) => {
          try {
            return githubIdentity(url) === githubIdentity(repository.url);
          } catch {
            return false;
          }
        });
      });
    if (matching.length !== 1 || matching[0] !== upstreamRemote)
      throw new Error("Expected exactly one matching GitHub upstream remote");
    const pushUrls = text(path, "remote", "get-url", "--push", "--all", upstreamRemote).split("\n");
    if (pushUrls.length !== 1 || githubIdentity(pushUrls[0]) !== githubIdentity(repository.url))
      throw new Error("Push URL differs from authorized repository");
  }
  const result: RewriteResult = {
    original,
    rewritten: original,
    commits: 0,
    invalidatedSignatures: 0,
  };
  if (options.validateOnly || options.dryRun) return result;
  const guard = referenceTransactions(path, branch, original);
  try {
    const suffix = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomBytes(6).toString("hex")}`;
    const recovery = `refs/heads/backup/coauthor-trailer-cleaner-${suffix}`;
    const transaction = `refs/coauthor-trailer-cleaner/transactions/${suffix}`;
    result.recoveryRef = recovery;
    const assertState = (expected: string): void => {
      if (
        text(path, "symbolic-ref", "--quiet", "HEAD") !== branch ||
        oid(path, branch) !== expected ||
        !clean(path)
      )
        throw new Error(
          `Repository changed; retained recovery ${recovery} and transaction ${transaction}`,
        );
    };
    assertState(original);
    guard.update([
      `verify ${branch} ${original}`,
      `create ${recovery} ${original}`,
      `create ${transaction} ${original}`,
    ]);
    if (options.backupRemote && !options.noPush)
      git(path, ["push", options.backupRemote, `${original}:${recovery}`]);
    const mapping = new Map<string, string>();
    const history = text(path, "rev-list", "--reverse", "--topo-order", original).split("\n");
    for (const commit of history) {
      const raw = git(path, ["cat-file", "commit", commit]);
      const transformed = transformCommit(raw, mapping, options.targets);
      const rewritten = transformed.bytes.equals(raw)
        ? commit
        : git(path, ["hash-object", "-t", "commit", "-w", "--stdin"], transformed.bytes)
            .toString("ascii")
            .trim();
      if (tree(path, commit) !== tree(path, rewritten))
        throw new Error(`Tree mismatch; retained ${recovery}`);
      mapping.set(commit, rewritten);
      result.commits++;
      result.invalidatedSignatures += transformed.invalidatedSignatures;
    }
    const rewritten = mapping.get(original);
    if (!rewritten) throw new Error("Missing rewritten HEAD");
    result.rewritten = rewritten;
    assertState(original);
    guard.update([
      `verify ${recovery} ${original}`,
      `update ${transaction} ${rewritten} ${original}`,
      `update ${branch} ${rewritten} ${original}`,
    ]);
    assertState(rewritten);
    if (!options.noPush) {
      try {
        guard.update([
          `verify ${recovery} ${original}`,
          `verify ${transaction} ${rewritten}`,
          `verify ${branch} ${rewritten}`,
        ]);
        git(path, [
          "push",
          upstreamRemote,
          `--force-with-lease=${upstreamRef}:${expectedUpstream}`,
          `${rewritten}:${upstreamRef}`,
        ]);
      } catch (error) {
        assertState(rewritten);
        if (tree(path, original) !== tree(path, rewritten))
          throw new Error("Rollback refused: tree mismatch");
        guard.update([
          `verify ${recovery} ${original}`,
          `verify ${transaction} ${rewritten}`,
          `update ${branch} ${original} ${rewritten}`,
        ]);
        throw new Error(
          `Push failed; restored local branch and retained ${recovery} and ${transaction}`,
          { cause: error },
        );
      }
    }
    assertState(rewritten);
    for (const commit of mapping.values()) {
      const raw = git(path, ["cat-file", "commit", commit]);
      const message = raw.subarray(raw.indexOf(Buffer.from("\n\n")) + 2);
      if (!cleanMessage(message, options.targets).equals(message))
        throw new Error("Target verification failed; recovery refs retained");
    }
    guard.update([
      `verify ${branch} ${rewritten}`,
      `delete ${recovery} ${original}`,
      `delete ${transaction} ${rewritten}`,
    ]);
    delete result.recoveryRef;
    return result;
  } finally {
    guard.close();
  }
}
