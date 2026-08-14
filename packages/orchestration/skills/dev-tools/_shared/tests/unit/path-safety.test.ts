/**
 * Verifies repository path checks reject traversal and symlink escapes before tools access workspace files.
 */
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRepoRelativePath, resolveWithinWorkspace } from "../../src/path-safety.js";

// Use realpathSync to normalize macOS /var -> /private/var symlinks.
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "shared-test-")));

type SymlinkResolution = {
  expected: string;
  linkPath: string;
  ref: string;
  target: string;
  workspaceRoot: string;
};

function expectBadInput(action: () => void, message: string): void {
  try {
    action();
    throw new Error("expected input validation failure");
  } catch (err: unknown) {
    expect(err).toMatchObject({ code: "E_BAD_INPUT", message });
  }
}

function createWorkspace(name: string): string {
  const workspace = path.join(tmp, name);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function createSymlinkOrSkip(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
    throw err;
  }
}

function expectResolvedPath(workspace: string, ref: string, expected: string): void {
  expect(resolveWithinWorkspace(workspace, ref, "ref")).toBe(expected);
}

function expectSymlinkResolution(resolution: SymlinkResolution): void {
  if (!createSymlinkOrSkip(resolution.target, resolution.linkPath)) return;
  expectResolvedPath(resolution.workspaceRoot, resolution.ref, resolution.expected);
}

function createInRootResolution(workspace: string): SymlinkResolution {
  const target = path.join(workspace, "target");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "inside.json"), "data");
  return {
    target,
    workspaceRoot: workspace,
    linkPath: path.join(workspace, "in-root-link"),
    ref: "in-root-link/inside.json",
    expected: path.join(workspace, "in-root-link", "inside.json"),
  };
}

function createRootResolution(workspace: string): SymlinkResolution {
  return {
    target: workspace,
    linkPath: path.join(tmp, "workspace-root-link"),
    workspaceRoot: path.join(tmp, "workspace-root-link"),
    ref: "not-created/yet.json",
    expected: path.join(workspace, "not-created", "yet.json"),
  };
}

describe("assertRepoRelativePath", () => {
  it.each(["contracts/foo.json", "a/b/c/d.txt"])("accepts %s", (ref) => {
    expect(() => assertRepoRelativePath(ref, "ref")).not.toThrow();
  });

  it.each([
    "/etc/passwd",
    "../outside",
    "foo/../../outside",
    "..",
    ".",
  ])("rejects unsafe reference %s", (ref) => {
    expectBadInput(() => assertRepoRelativePath(ref, "ref"), "ref must be repository-relative");
  });

  it.each([
    "",
    "   ",
    42 as unknown as string,
  ])("rejects non-empty validation failure %#", (ref) => {
    expectBadInput(() => assertRepoRelativePath(ref, "ref"), "ref must be a non-empty string");
  });
});

describe("resolveWithinWorkspace", () => {
  it("resolves a simple relative path within the workspace", () => {
    const result = resolveWithinWorkspace(tmp, "foo/bar.txt", "ref");
    expect(result).toBe(path.join(tmp, "foo", "bar.txt"));
  });

  it.each(["../escape", "/etc/passwd"])("rejects escaping reference %s", (ref) => {
    expectBadInput(
      () => resolveWithinWorkspace(tmp, ref, "ref"),
      "ref must resolve within workspaceRoot",
    );
  });

  it("validates the workspace root before the relative reference", () => {
    expectBadInput(
      () => resolveWithinWorkspace("", "../escape", "ref"),
      "workspaceRoot must be a non-empty string",
    );
  });

  it("rejects empty relative ref", () => {
    expectBadInput(() => resolveWithinWorkspace(tmp, "", "ref"), "ref must be a non-empty string");
  });

  it("rejects non-existent workspace root", () => {
    expectBadInput(
      () => resolveWithinWorkspace("/nonexistent-root-xyz", "foo.txt", "ref"),
      "workspaceRoot does not exist",
    );
  });

  it("uses custom rootLabel in error messages", () => {
    expectBadInput(
      () =>
        resolveWithinWorkspace("", "foo.txt", "ref", {
          rootLabel: "projectRoot",
        }),
      "projectRoot must be a non-empty string",
    );
  });

  it.each([
    ["in-root descendant", "workspace-in-root-link", createInRootResolution],
    ["workspace root", "workspace-root-target", createRootResolution],
  ])("returns the lexical path through an %s symlink", (_, workspaceName, createResolution) => {
    const workspace = createWorkspace(workspaceName);
    expectSymlinkResolution(createResolution(workspace));
  });

  it.each([
    ["existing descendant", "sneaky-link/secret.txt", true],
    ["nonexistent descendant", "sneaky-link/not-created/yet.json", false],
  ])("catches an escaping symlink with a %s", (name, ref, createDescendant) => {
    const workspace = createWorkspace(`workspace-escaping-${name}`);
    const outside = createWorkspace(`outside-escaping-${name}`);
    if (createDescendant) writeFileSync(path.join(outside, "secret.txt"), "data");
    if (!createSymlinkOrSkip(outside, path.join(workspace, "sneaky-link"))) return;
    expectBadInput(
      () => resolveWithinWorkspace(workspace, ref, "ref"),
      "ref must resolve within workspaceRoot",
    );
  });

  it("resolves a nonexistent descendant through the deepest existing ancestor", () => {
    const workspace = createWorkspace("workspace-nonexistent-descendant");

    expectResolvedPath(
      workspace,
      "not-created/yet.json",
      path.join(workspace, "not-created", "yet.json"),
    );
  });

  it("propagates non-ENOENT errors while resolving ancestors", () => {
    const workspace = createWorkspace("workspace-non-enoent");
    const blockingFile = path.join(workspace, "blocking-file");
    writeFileSync(blockingFile, "data");

    try {
      resolveWithinWorkspace(workspace, "blocking-file/child.json", "ref");
      throw new Error("expected non-ENOENT failure");
    } catch (err: unknown) {
      expect(err).toMatchObject({ code: "ENOTDIR" });
    }
  });
});
