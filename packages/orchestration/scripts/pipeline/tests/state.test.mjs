import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  phaseToArtifactKey,
  getRunDir,
  getRepoRoot,
  getPipelineDir,
  getWorkspaceFromState,
  gateFileNameForPhase,
  loadPipelineState,
  parseBooleanFlag,
  readJson,
  readJsonStrict,
  resolveWithinRepo,
  resolveWithinDirectory,
  savePipelineState,
  withLockedState,
} from "../lib/state.mjs";

describe("phaseToArtifactKey", () => {
  it("maps arm to brief", () => {
    expect(phaseToArtifactKey("arm")).toBe("brief");
  });

  it("maps design to design", () => {
    expect(phaseToArtifactKey("design")).toBe("design");
  });

  it("maps adversarial-review to review", () => {
    expect(phaseToArtifactKey("adversarial-review")).toBe("review");
  });

  it("maps plan to plan", () => {
    expect(phaseToArtifactKey("plan")).toBe("plan");
  });

  it("maps pmatch to drift_reports", () => {
    expect(phaseToArtifactKey("pmatch")).toBe("drift_reports");
  });

  it("maps build to build", () => {
    expect(phaseToArtifactKey("build")).toBe("build");
  });

  it("maps release-readiness to release_readiness", () => {
    expect(phaseToArtifactKey("release-readiness")).toBe("release_readiness");
  });

  it("maps post-build to post_build", () => {
    expect(phaseToArtifactKey("post-build")).toBe("post_build");
  });

  it("maps quality-static to quality_reports", () => {
    expect(phaseToArtifactKey("quality-static")).toBe("quality_reports");
  });

  it("maps quality-tests to quality_reports", () => {
    expect(phaseToArtifactKey("quality-tests")).toBe("quality_reports");
  });

  it("maps security-review to quality_reports", () => {
    expect(phaseToArtifactKey("security-review")).toBe("quality_reports");
  });

  it("maps denoise to quality_reports", () => {
    expect(phaseToArtifactKey("denoise")).toBe("quality_reports");
  });

  it("returns null for unknown phase", () => {
    expect(phaseToArtifactKey("nonexistent")).toBeNull();
  });
});

describe("getRunDir", () => {
  it("rejects empty run_id", () => {
    expect(() => getRunDir("")).toThrow(/run_id is required/);
  });

  it("rejects null run_id", () => {
    expect(() => getRunDir(null)).toThrow(/run_id is required/);
  });

  it("rejects run_id with path separators", () => {
    expect(() => getRunDir("../escape")).toThrow();
  });

  it("rejects run_id with special characters", () => {
    expect(() => getRunDir("id with spaces")).toThrow();
  });

  it("accepts valid UUID run_id", () => {
    const dir = getRunDir("abc-123-def");
    expect(dir).toContain("abc-123-def");
  });
});

describe("gateFileNameForPhase", () => {
  it("returns postbuild-gate.json for post-build", () => {
    expect(gateFileNameForPhase("post-build")).toBe("postbuild-gate.json");
  });

  it("returns phase-gate.json for other phases", () => {
    expect(gateFileNameForPhase("arm")).toBe("arm-gate.json");
    expect(gateFileNameForPhase("plan")).toBe("plan-gate.json");
  });
});

describe("parseBooleanFlag", () => {
  it("returns true for boolean true", () => {
    expect(parseBooleanFlag(true)).toBe(true);
  });

  it("returns false for boolean false", () => {
    expect(parseBooleanFlag(false)).toBe(false);
  });

  it("parses string 'true' as true", () => {
    expect(parseBooleanFlag("true")).toBe(true);
    expect(parseBooleanFlag("1")).toBe(true);
    expect(parseBooleanFlag("yes")).toBe(true);
  });

  it("parses string 'false' as false", () => {
    expect(parseBooleanFlag("false")).toBe(false);
    expect(parseBooleanFlag("0")).toBe(false);
    expect(parseBooleanFlag("no")).toBe(false);
  });

  it("returns false for undefined/null", () => {
    expect(parseBooleanFlag(undefined)).toBe(false);
    expect(parseBooleanFlag(null)).toBe(false);
  });
});

describe("getWorkspaceFromState", () => {
  it("normalizes legacy state without explicit workspace metadata", () => {
    expect(getWorkspaceFromState({ run_id: "legacy" }, "/tmp/legacy-root")).toEqual({
      mode: "main-repo",
      root: "/tmp/legacy-root",
      primary_repo_root: "/tmp/legacy-root",
      branch: "",
      worktree_path: null,
      cleanup_command: null,
    });
  });

  it("preserves explicit worktree metadata", () => {
    expect(
      getWorkspaceFromState(
        {
          workspace: {
            mode: "git-worktree",
            root: "/tmp/repo/.worktrees/run-1",
            primary_repo_root: "/tmp/repo",
            branch: "pipeline/run-1",
            worktree_path: "/tmp/repo/.worktrees/run-1",
            cleanup_command:
              "bash scripts/pipeline-init.sh --cleanup-worktree /tmp/repo/.worktrees/run-1",
          },
        },
        "/tmp/repo/.worktrees/run-1",
      ),
    ).toEqual({
      mode: "git-worktree",
      root: "/tmp/repo/.worktrees/run-1",
      primary_repo_root: "/tmp/repo",
      branch: "pipeline/run-1",
      worktree_path: "/tmp/repo/.worktrees/run-1",
      cleanup_command:
        "bash scripts/pipeline-init.sh --cleanup-worktree /tmp/repo/.worktrees/run-1",
    });
  });
});

describe("readJson", () => {
  it("returns fallback for non-existent file", () => {
    expect(readJson("/tmp/nonexistent-test-file.json")).toBeNull();
    expect(readJson("/tmp/nonexistent-test-file.json", { default: true })).toEqual({
      default: true,
    });
  });

  it("parses valid JSON file", () => {
    const path = "/tmp/test-readjson-valid.json";
    writeFileSync(path, '{"key": "value"}', "utf8");
    try {
      expect(readJson(path)).toEqual({ key: "value" });
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("throws on malformed JSON", () => {
    const path = "/tmp/test-readjson-invalid.json";
    writeFileSync(path, "{broken json", "utf8");
    try {
      expect(() => readJson(path)).toThrow(/failed to parse JSON/);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("readJsonStrict", () => {
  it("throws for non-existent file", () => {
    expect(() => readJsonStrict("/tmp/nonexistent-strict.json")).toThrow(/file not found/);
  });

  it("throws on malformed JSON with context", () => {
    const path = "/tmp/test-readjsonstrict-invalid.json";
    writeFileSync(path, "not json", "utf8");
    try {
      expect(() => readJsonStrict(path, "test artifact")).toThrow(/test artifact/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("returns parsed JSON for valid file", () => {
    const path = "/tmp/test-readjsonstrict-valid.json";
    writeFileSync(path, '{"ok": true}', "utf8");
    try {
      expect(readJsonStrict(path)).toEqual({ ok: true });
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("resolveWithinRepo", () => {
  const root = getRepoRoot();

  it("rejects path traversal (../../../etc/passwd)", () => {
    expect(() => resolveWithinRepo("../../../etc/passwd", root)).toThrow(
      /path escapes repository root/,
    );
  });

  it("rejects absolute path outside the repo", () => {
    expect(() => resolveWithinRepo("/tmp/evil", root)).toThrow(/path escapes repository root/);
  });

  it("accepts valid relative path within the repo", () => {
    const result = resolveWithinRepo("scripts/verify.sh", root);
    expect(result).toContain("scripts");
    expect(result).toContain("verify.sh");
  });
});

describe("resolveWithinDirectory", () => {
  const tmpBase = resolve("/tmp", "test-resolve-within-dir");

  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
    writeFileSync(resolve(tmpBase, "ok.txt"), "ok", "utf8");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("rejects path traversal (../../../etc/passwd)", () => {
    expect(() => resolveWithinDirectory(tmpBase, "../../../etc/passwd")).toThrow(
      /path escapes base directory/,
    );
  });

  it("rejects absolute path outside the directory by default", () => {
    expect(() => resolveWithinDirectory(tmpBase, "/tmp/evil")).toThrow(/must be relative/);
  });

  it("accepts valid relative path within the directory", () => {
    const result = resolveWithinDirectory(tmpBase, "ok.txt");
    expect(result).toContain("ok.txt");
  });
});

describe("withLockedState", () => {
  let savedState;

  beforeEach(() => {
    // Snapshot current pipeline state
    try {
      savedState = loadPipelineState();
    } catch {
      savedState = null;
    }
    // Ensure a valid state exists
    const state = savedState || {
      run_id: "lock-test",
      current_phase: "arm",
      phase_order: ["arm"],
      completed_gates: [],
      artifacts: {},
      config: {},
    };
    savePipelineState(state);
  });

  afterEach(() => {
    // Clean up any stale lock file
    const lockPath = resolve(getPipelineDir(), "pipeline-state.lock");
    rmSync(lockPath, { force: true });
    // Restore original state
    if (savedState) {
      savePipelineState(savedState);
    }
  });

  it("provides state to callback and saves after", () => {
    withLockedState(undefined, (state) => {
      state._test_marker = true;
    });

    const updated = loadPipelineState();
    expect(updated._test_marker).toBe(true);
  });

  it("returns the value from the callback", () => {
    const result = withLockedState(undefined, () => 42);
    expect(result).toBe(42);
  });

  it("removes the lock file after success", () => {
    const lockPath = resolve(getPipelineDir(), "pipeline-state.lock");
    withLockedState(undefined, () => {});
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes the lock file after callback throws", () => {
    const lockPath = resolve(getPipelineDir(), "pipeline-state.lock");
    expect(() =>
      withLockedState(undefined, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("throws when lock is already held", () => {
    const lockPath = resolve(getPipelineDir(), "pipeline-state.lock");
    writeFileSync(lockPath, "", "utf8");
    try {
      expect(() => withLockedState(undefined, () => {})).toThrow(/locked by another process/);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  it("keeps the lock until an async callback resolves", async () => {
    const lockPath = resolve(getPipelineDir(), "pipeline-state.lock");
    let release;
    const gate = new Promise((resolvePromise) => {
      release = resolvePromise;
    });

    const pending = withLockedState(undefined, async (state) => {
      state._async_marker = true;
      await gate;
      return 42;
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(() => withLockedState(undefined, () => {})).toThrow(/locked by another process/);

    release();
    await expect(pending).resolves.toBe(42);
    expect(existsSync(lockPath)).toBe(false);
    expect(loadPipelineState()._async_marker).toBe(true);
  });
});
