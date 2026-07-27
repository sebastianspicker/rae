/**
 * Verifies repository path checks reject traversal and symlink escapes before tools access workspace files.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRepoRelativePath, resolveWithinWorkspace } from "../../src/path-safety.js";

describe("assertRepoRelativePath", () => {
  it("accepts a simple relative path", () => {
    expect(() => assertRepoRelativePath("contracts/foo.json", "ref")).not.toThrow();
  });

  it("accepts nested relative paths", () => {
    expect(() => assertRepoRelativePath("a/b/c/d.txt", "ref")).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => assertRepoRelativePath("/etc/passwd", "ref")).toThrow(
      "must be repository-relative",
    );
  });

  it("rejects parent traversal", () => {
    expect(() => assertRepoRelativePath("../outside", "ref")).toThrow(
      "must be repository-relative",
    );
    expect(() => assertRepoRelativePath("foo/../../outside", "ref")).toThrow(
      "must be repository-relative",
    );
  });

  it("rejects bare dot-dot", () => {
    expect(() => assertRepoRelativePath("..", "ref")).toThrow("must be repository-relative");
  });

  it("rejects bare dot", () => {
    expect(() => assertRepoRelativePath(".", "ref")).toThrow("must be repository-relative");
  });

  it("rejects empty string", () => {
    expect(() => assertRepoRelativePath("", "ref")).toThrow("must be a non-empty string");
  });

  it("rejects whitespace-only string", () => {
    expect(() => assertRepoRelativePath("   ", "ref")).toThrow("must be a non-empty string");
  });

  it("rejects non-string input", () => {
    expect(() => assertRepoRelativePath(42 as unknown as string, "ref")).toThrow(
      "must be a non-empty string",
    );
  });
});

describe("resolveWithinWorkspace", () => {
  // Use realpathSync to normalize macOS /var -> /private/var symlinks
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "shared-test-")));

  it("resolves a simple relative path within the workspace", () => {
    const result = resolveWithinWorkspace(tmp, "foo/bar.txt", "ref");
    expect(result).toBe(path.join(tmp, "foo", "bar.txt"));
  });

  it("rejects parent traversal", () => {
    expect(() => resolveWithinWorkspace(tmp, "../escape", "ref")).toThrow("must resolve within");
  });

  it("rejects absolute paths", () => {
    expect(() => resolveWithinWorkspace(tmp, "/etc/passwd", "ref")).toThrow("must resolve within");
  });

  it("rejects empty workspace root", () => {
    expect(() => resolveWithinWorkspace("", "foo.txt", "ref")).toThrow(
      "must be a non-empty string",
    );
  });

  it("rejects empty relative ref", () => {
    expect(() => resolveWithinWorkspace(tmp, "", "ref")).toThrow("must be a non-empty string");
  });

  it("rejects non-existent workspace root", () => {
    expect(() => resolveWithinWorkspace("/nonexistent-root-xyz", "foo.txt", "ref")).toThrow(
      "does not exist",
    );
  });

  it("uses custom rootLabel in error messages", () => {
    expect(() =>
      resolveWithinWorkspace("", "foo.txt", "ref", {
        rootLabel: "projectRoot",
      }),
    ).toThrow("projectRoot must be a non-empty string");
  });

  it("catches symlink escape", () => {
    // Create a nested workspace with a symlink pointing outside it
    const workspace = path.join(tmp, "workspace");
    const outside = path.join(tmp, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // Create the target file so realpathSync can resolve through the symlink
    writeFileSync(path.join(outside, "secret.txt"), "data");
    const linkPath = path.join(workspace, "sneaky-link");
    try {
      symlinkSync(outside, linkPath);
    } catch {
      return;
    }
    expect(() => resolveWithinWorkspace(workspace, "sneaky-link/secret.txt", "ref")).toThrow(
      "must resolve within",
    );
  });

  it("catches a nonexistent descendant beneath an escaping symlink", () => {
    const workspace = path.join(tmp, "workspace-nonexistent-descendant");
    const outside = path.join(tmp, "outside-nonexistent-descendant");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(workspace, "sneaky-link"));

    expect(() =>
      resolveWithinWorkspace(workspace, "sneaky-link/not-created/yet.json", "ref"),
    ).toThrow("must resolve within");
  });
});
