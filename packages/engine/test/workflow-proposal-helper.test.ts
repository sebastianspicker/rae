/** Characterizes the compiled proposal helper and its bounded provider lifecycle. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import test from "node:test";
import { runBoundedProcess } from "../src/agents/bounded-process.js";
import { workflowsRoot } from "../src/primitives/installation-paths.js";
import { loadWorkflow } from "../src/workflow/workflow-contract.js";
import {
  parseProposalHelperRequest,
  type ProposalHelperRequest,
} from "../src/workflow/workflow-proposal-helper.js";
import { proposeWorkflowCandidate } from "../src/workflow/workflow-proposal.js";

const HELPER_PATH = resolve(import.meta.dirname, "../src/workflow/workflow-proposal-helper.js");

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

function helperRequest(projectRoot: string, temporary: string): ProposalHelperRequest {
  return {
    projectRoot,
    prompt: "Propose a bounded workflow",
    temporary,
    attempt: 1,
    execution: null,
  };
}

test("proposal helper rejects malformed requests before provider startup", () => {
  assert.throws(
    () => parseProposalHelperRequest({ projectRoot: "/tmp", attempt: 3 }),
    /attempt must be 1 or 2/,
  );

  const result = spawnSync(process.execPath, [HELPER_PATH], {
    input: JSON.stringify({ projectRoot: "/tmp", attempt: 3 }),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    success: false,
    error: { message: "proposal helper attempt must be 1 or 2" },
  });
});

test("proposal helper fails closed without writing provider diagnostics to stderr", () => {
  const root = temporaryDirectory("rae-proposal-helper-failure-");
  const emptyPath = resolve(root, "empty-path");
  const temporary = resolve(root, "temporary");
  try {
    const result = spawnSync(process.execPath, [HELPER_PATH], {
      cwd: root,
      input: JSON.stringify(helperRequest(root, temporary)),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: emptyPath },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      success: false,
      error: { message: "Codex CLI is not available on PATH" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal candidate rejects protected task file path components", () => {
  const root = temporaryDirectory("rae-proposal-protected-task-");
  const basePath = resolve(workflowsRoot, "recipes/route-audit.workflow.json");
  const protectedPaths = [
    ".ssh/task.md",
    "notes/TOKEN-token-token.md",
    "notes/private-key-plan.txt",
  ];
  try {
    const init = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    for (const taskFile of protectedPaths) {
      const taskPath = resolve(root, taskFile);
      mkdirSync(dirname(taskPath), { recursive: true });
      writeFileSync(taskPath, "Never read this task file");
      assert.throws(
        () => proposeWorkflowCandidate({ projectRoot: root, taskFile, baseWorkflow: basePath }),
        /protected credential material/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal candidate API returns a workflow synchronously through the helper", () => {
  const root = temporaryDirectory("rae-proposal-helper-sync-");
  const bin = resolve(root, "bin");
  const basePath = resolve(workflowsRoot, "recipes/route-audit.workflow.json");
  const base = loadWorkflow(basePath).workflow;
  const candidate = { ...base, revision: base.revision + 1 };
  try {
    const init = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    mkdirSync(bin, { mode: 0o700 });
    const script =
      `#!${process.execPath}\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const index = process.argv.indexOf("--output-last-message");\n` +
      `if (index < 0 || !process.argv[index + 1]) process.exit(64);\n` +
      `writeFileSync(process.argv[index + 1], ${JSON.stringify(JSON.stringify(candidate))});\n` +
      `process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}}) + "\\n");\n`;
    writeFileSync(resolve(bin, "codex"), script, { encoding: "utf8", mode: 0o700 });
    chmodSync(resolve(bin, "codex"), 0o700);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      const result = proposeWorkflowCandidate({
        projectRoot: root,
        task: "Audit one route",
        baseWorkflow: basePath,
      });
      assert.equal(result instanceof Promise, false);
      assert.deepEqual(result, candidate);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded timeout awaits the absence of a stubborn provider process group", async (context) => {
  if (process.platform === "win32") context.skip("POSIX process-group assertion");
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parent = [
    "const {spawn}=require('node:child_process')",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "process.on('SIGTERM',()=>{})",
    "setInterval(()=>{},1000)",
  ].join(";");
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", parent],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 100,
  });
  assert.equal(result.termination?.reason, "timeout");
  assert.equal(result.termination?.groupTerminationAttempted, true);
  assert.equal(result.termination?.closeObserved, true);
  assert.equal(result.termination?.groupAbsentObserved, true);
  assert.equal(result.termination?.containmentUncertain, false);
});

test("bounded output retains only a capped tail after overflow", async () => {
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 10_000,
    stdoutLimitBytes: 1024,
  });
  assert.equal(result.termination?.reason, "stdout_overflow");
  assert.ok(result.stdoutBytes > 1024);
  assert.equal(result.stdout, "");
  assert.ok(Buffer.byteLength(result.stdoutTail, "utf8") <= 64 * 1024);
});
