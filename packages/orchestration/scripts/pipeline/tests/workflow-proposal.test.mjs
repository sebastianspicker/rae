/** Verifies proposal event logs use their private temporary authorization root. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runAgentPhase } from "../lib/agent-executor.mjs";
import { proposeWorkflowCandidate } from "../lib/workflow-proposal.mjs";

const roots = [];
const packageRoot = resolve(import.meta.dirname, "../../..");
const baseRecipe = resolve(packageRoot, "workflows/recipes/route-audit.workflow.json");
const workflowSchema = resolve(packageRoot, "contracts/workflows/workflow-v2.1.schema.json");

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "rae-workflow-proposal-test-"));
  roots.push(projectRoot);
  execFileSync("git", ["init", "-q", projectRoot]);
  const base = JSON.parse(readFileSync(baseRecipe, "utf8"));
  const candidate = { ...base, revision: base.revision + 1 };
  const executable = join(projectRoot, "codex");
  writeFileSync(
    executable,
    `#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);if(a.includes("exec")){const output=a[a.indexOf("--output-last-message")+1];fs.writeFileSync(output,${JSON.stringify(`${JSON.stringify(candidate)}\n`)});fs.writeFileSync("proposal-output-path.txt",output);process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":1,"output_tokens":1,"reasoning_output_tokens":1}}\\n')}\n`,
    "utf8",
  );
  chmodSync(executable, 0o755);
  return { projectRoot, candidate, executable };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("proposal event logs use the private temporary root while external logs remain rejected", () => {
  const item = fixture();
  const priorPath = process.env.PATH;
  process.env.PATH = `${item.projectRoot}${process.platform === "win32" ? ";" : ":"}${priorPath ?? ""}`;
  try {
    expect(
      proposeWorkflowCandidate({
        projectRoot: item.projectRoot,
        baseWorkflow: baseRecipe,
        task: "Review workflow routing.",
      }),
    ).toEqual(item.candidate);
    expect(readFileSync(join(item.projectRoot, "proposal-output-path.txt"), "utf8")).toContain(
      "rae-workflow-proposal-",
    );
    expect(() =>
      runAgentPhase({
        provider: "codex",
        workspaceRoot: item.projectRoot,
        schemaPath: workflowSchema,
        outputPath: join(item.projectRoot, "direct-output.json"),
        eventLogPath: join(tmpdir(), "outside-proposal.events.jsonl"),
        prompt: "fixture",
        sandboxMode: "read-only",
        env: { PATH: item.projectRoot },
      }),
    ).toThrow("event log path must be a file below the authorized workspace root");
  } finally {
    process.env.PATH = priorPath;
  }
});
