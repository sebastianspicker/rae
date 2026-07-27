#!/usr/bin/env node
/**
 * Provides the fake-agent executable fixture used to exercise pipeline agent integration deterministically.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { buildArtifactForPhase, buildContextManifest } from "../../lib/artifacts.mjs";

const request = JSON.parse(readFileSync(0, "utf8"));
const phase = request.phase;
const requirements = ["REQ-001"];
const artifact = buildArtifactForPhase({
  phase,
  runId: request.run_id,
  configId: "phased_default",
  task: { id: "fake-task", must_requirement_ids: requirements },
  stageProfile: { drift_status: "verified", files_loaded: 2, token_estimate: 800 },
  budget: { files_max: 64, token_max: 24_000 },
});

if (phase === "release-readiness" && request.prompt.includes("STOP_DURING_PROVIDER_FIXTURE")) {
  const autonomous = resolve(import.meta.dirname, "../../autonomous.mjs");
  const stop = spawnSync(
    process.execPath,
    [
      autonomous,
      "stop",
      "--project-root",
      request.workspace_root,
      "--run-id",
      request.run_id,
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (stop.status !== 0) {
    throw new Error(`fixture stop request failed: ${stop.stderr}`);
  }
}

if (phase === "plan") {
  const defaultTask = artifact.task_groups[0].tasks[0];
  const defaultTest = defaultTask.test_cases[0];
  artifact.task_groups = [
    {
      group_id: "implementation",
      builder_tier: "fast",
      tasks: [
        {
          ...defaultTask,
          id: "implement-value",
          trace_id: "task-implement-value",
          description: "Implement the requested value and document it",
          covers_requirement_ids: requirements,
          covers_constraint_ids: ["constraint-contracts"],
          file_paths: ["src/value.txt", "README.md"],
          code_patterns: [
            {
              file: "src/value.txt",
              pattern: "implemented",
              description: "Observable implementation output",
            },
          ],
          test_cases: [
            {
              ...defaultTest,
              name: "value-smoke",
              trace_id: "test-value-smoke",
              covers_requirement_ids: requirements,
              setup: "Read src/value.txt",
              assertion: "The requested value is present",
              expected: "implemented",
            },
          ],
          acceptance_criteria: ["src/value.txt contains implemented", "README documents behavior"],
          dependencies: [],
        },
      ],
    },
  ];
  artifact.file_ownership = {
    "README.md": "implementation",
    "src/value.txt": "implementation",
  };
  artifact.documentation = {
    required: true,
    paths: ["README.md"],
    rationale: "The fixture exposes a user-visible value that must be documented.",
  };
  if (request.prompt.includes("UNSAFE_PLAN_PATH_FIXTURE")) {
    artifact.file_ownership["../escape.txt"] = "implementation";
  }
  artifact.verification_commands = [
    {
      command: "git diff --check",
      description: "Check patch whitespace",
      working_directory: ".",
      evidence_roles: ["build", "quality-static", "post-build"],
      evidence_kind: "static",
    },
    {
      command: "npm test",
      description: "Run the fixture test suite",
      working_directory: ".",
      evidence_roles: ["quality-tests"],
      evidence_kind: "tests",
    },
  ];
}

if (phase === "build") {
  const initialHead = spawnSync("git", ["-C", request.workspace_root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  mkdirSync(resolve(request.workspace_root, "src"), { recursive: true });
  writeFileSync(resolve(request.workspace_root, "src/value.txt"), "implemented\n", "utf8");
  if (!request.prompt.includes("NO_DOCUMENTATION_FIXTURE")) {
    const readmePath = resolve(request.workspace_root, "README.md");
    const readme = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, `${readme.trim()}\n\nImplemented value: \`implemented\`.\n`, "utf8");
  }
  if (request.prompt.includes("OUT_OF_SCOPE_FIXTURE")) {
    writeFileSync(resolve(request.workspace_root, "unowned.txt"), "not allowed\n", "utf8");
  }
  if (request.prompt.includes("PRIVATE_EXCLUDE_HIDE_FIXTURE")) {
    const gitPath = (name) => {
      const pathResult = spawnSync(
        "git",
        [
          "-C",
          request.workspace_root,
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          `info/${name}`,
        ],
        { encoding: "utf8" },
      );
      if (pathResult.status !== 0) {
        throw new Error(`fixture Git ${name} path lookup failed: ${pathResult.stderr}`);
      }
      return pathResult.stdout.trim();
    };
    const excludePath = gitPath("exclude");
    const attributesPath = gitPath("attributes");
    mkdirSync(dirname(excludePath), { recursive: true });
    mkdirSync(dirname(attributesPath), { recursive: true });
    writeFileSync(excludePath, "unauthorized.txt\n", "utf8");
    writeFileSync(attributesPath, "unauthorized.txt -diff\n", "utf8");
    writeFileSync(resolve(request.workspace_root, "unauthorized.txt"), "not allowed\n", "utf8");
    const nestedRuntimeLookalike = resolve(request.workspace_root, "nested/.pipeline/hidden.txt");
    mkdirSync(dirname(nestedRuntimeLookalike), { recursive: true });
    writeFileSync(nestedRuntimeLookalike, "also not allowed\n", "utf8");
  }
  if (request.prompt.includes("PIPELINE_PLAN_TAMPER_FIXTURE")) {
    const planPath = resolve(
      request.workspace_root,
      ".pipeline",
      "runs",
      request.run_id,
      "plan.json",
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.file_ownership["unowned.txt"] = "implementation";
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    writeFileSync(resolve(request.workspace_root, "unowned.txt"), "not allowed\n", "utf8");
  }
  if (
    request.prompt.includes("COMMIT_FIXTURE") ||
    request.prompt.includes("COMMIT_RESET_FIXTURE")
  ) {
    const add = spawnSync("git", ["-C", request.workspace_root, "add", "-A"], {
      encoding: "utf8",
    });
    if (add.status !== 0) {
      throw new Error(`fixture add failed: ${add.stderr}`);
    }
    const commit = spawnSync(
      "git",
      [
        "-C",
        request.workspace_root,
        "-c",
        "user.name=RAE Fixture",
        "-c",
        "user.email=rae-fixture@example.invalid",
        "commit",
        "-am",
        "fixture prohibited commit",
      ],
      { encoding: "utf8" },
    );
    if (commit.status !== 0) {
      throw new Error(`fixture commit failed: ${commit.stderr}`);
    }
    if (request.prompt.includes("COMMIT_RESET_FIXTURE")) {
      const reset = spawnSync(
        "git",
        ["-C", request.workspace_root, "reset", "--hard", initialHead],
        { encoding: "utf8" },
      );
      if (reset.status !== 0) {
        throw new Error(`fixture reset failed: ${reset.stderr}`);
      }
    }
  }
  if (request.prompt.includes("REMOTE_MUTATION_FIXTURE")) {
    const remote = spawnSync(
      "git",
      [
        "-C",
        request.workspace_root,
        "remote",
        "add",
        "fixture",
        "https://example.invalid/rae-fixture.git",
      ],
      { encoding: "utf8" },
    );
    if (remote.status !== 0) {
      throw new Error(`fixture remote mutation failed: ${remote.stderr}`);
    }
  }
  if (request.prompt.includes("CORE_WORKTREE_MUTATION_FIXTURE")) {
    const shadow = resolve(request.workspace_root, "..", "shadow-worktree");
    mkdirSync(shadow, { recursive: true });
    const mutation = spawnSync(
      "git",
      ["-C", request.workspace_root, "config", "core.worktree", shadow],
      { encoding: "utf8" },
    );
    if (mutation.status !== 0) {
      throw new Error(`fixture core.worktree mutation failed: ${mutation.stderr}`);
    }
  }
  if (request.prompt.includes("TAG_MUTATION_FIXTURE")) {
    const tag = spawnSync(
      "git",
      ["-C", request.workspace_root, "tag", "rae-prohibited-provider-tag"],
      { encoding: "utf8" },
    );
    if (tag.status !== 0) {
      throw new Error(`fixture tag mutation failed: ${tag.stderr}`);
    }
  }
  if (request.prompt.includes("OTHER_REF_MUTATION_FIXTURE")) {
    const branch = spawnSync(
      "git",
      ["-C", request.workspace_root, "branch", "rae-prohibited-provider-branch"],
      { encoding: "utf8" },
    );
    if (branch.status !== 0) {
      throw new Error(`fixture branch mutation failed: ${branch.stderr}`);
    }
  }
  const indexMutation = [
    ["STAGE_FIXTURE", ["add", "README.md"]],
    ["ASSUME_UNCHANGED_FIXTURE", ["update-index", "--assume-unchanged", ".gitignore"]],
    ["SKIP_WORKTREE_FIXTURE", ["update-index", "--skip-worktree", ".gitignore"]],
    ["FSMONITOR_VALID_FIXTURE", ["update-index", "--fsmonitor-valid", "README.md"]],
  ].find(([marker]) => request.prompt.includes(marker));
  if (indexMutation) {
    const mutation = spawnSync("git", ["-C", request.workspace_root, ...indexMutation[1]], {
      encoding: "utf8",
    });
    if (mutation.status !== 0) {
      throw new Error(`fixture index mutation failed: ${mutation.stderr}`);
    }
  }
  artifact.summary = "Implemented the requested value and updated user documentation.";
  artifact.outputs = ["src/value.txt", "README.md"];
  artifact.covers_requirement_ids = requirements;
}

if (["quality-static", "quality-tests"].includes(phase)) {
  artifact.evidence_bundle = {
    status: "complete",
    references: [
      {
        type: "verification-command",
        path: "git diff --check",
        description: "Fixture verification completed successfully",
      },
    ],
    missing_types: [],
    residual_gaps: [],
  };
}

if (phase === "post-build") {
  const categories = [
    "access-control",
    "xss",
    "csrf",
    "secrets",
    "security-headers",
    "cookies-session",
    "production-exposure",
    "dependencies",
    "ssrf",
    "file-upload",
    "injection",
    "path-traversal",
    "open-redirect",
    "jwt-auth",
  ];
  const postBuildArtifact = {
    audit_type: "security",
    violations: [],
    summary: { pass: 3, warn: 0, fail: 0, open: 0, fixed: 0, accepted_risk: 0 },
    security_audit: {
      categories_covered: categories,
      checks: {
        access_control: true,
        xss: true,
        csrf: true,
        secrets: true,
        security_headers: true,
        cookies_session: true,
        production_exposure: true,
        dependencies: true,
        ssrf: true,
        file_upload: true,
        injection: true,
        path_traversal: true,
        open_redirect: true,
        jwt_auth: true,
      },
      fix_loop: {
        rounds: 1,
        critical_high_before: 0,
        critical_high_after: 0,
        rescan_completed: true,
      },
      tools: ["fixture-review"],
      risk_signoff_required: false,
    },
    evidence_bundle: {
      status: "complete",
      references: [
        {
          type: "verification-command",
          path: "git diff --check",
          description: "Fixture security review completed successfully",
        },
        {
          type: "documentation",
          path: "README.md",
          description: "User-facing behavior is documented",
          user_surface: true,
        },
      ],
      missing_types: [],
      residual_gaps: [],
    },
    context_manifest: buildContextManifest({
      phase,
      stageProfile: { files_loaded: 3, token_estimate: 900 },
      budget: null,
    }),
  };
  process.stdout.write(`${JSON.stringify(postBuildArtifact)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}
