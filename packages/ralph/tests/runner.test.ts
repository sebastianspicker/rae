/** Verifies provider retries, report contracts, and isolated story promotion. */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXIT, RalphError } from "../src/errors.js";
import { Logger } from "../src/logger.js";
import { modelPreflight, processStory } from "../src/runner.js";
import { pointerPath } from "../src/transaction.js";
import type { CliOptions, Prd, RuntimePaths, Story } from "../src/types.js";

interface Fixture {
  repo: string;
  metadata: string;
  fakeBin: string;
  control: string;
  paths: RuntimePaths;
  prd: Prd;
  story: Story;
  options: CliOptions;
  close(): void;
}

function fixture(
  action:
    | "success"
    | "outside"
    | "ignored"
    | "retry"
    | "missing-reference"
    | "missing-link"
    | "missing-date"
    | "preflight" = "success",
): Fixture {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-runner-repo-")));
  const metadata = realpathSync.native(mkdtempSync(join(homedir(), ".ralph-runner-metadata-")));
  const fakeBin = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-runner-bin-")));
  const control = realpathSync.native(mkdtempSync(join(tmpdir(), `ralph-runner-${action}-`)));
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
  mkdirSync(paths.stateDir, { mode: 0o700 });
  chmodSync(metadata, 0o700);
  const story: Story = {
    id: "STORY-1",
    title: "Bounded provider run",
    priority: 1,
    mode: "fixing",
    scope: ["docs/**", "reports/**"],
    acceptance_criteria: ["Created `reports/STORY-1.md` with evidence"],
    passes: false,
  };
  const prd: Prd = {
    project: "runner-test",
    defaults: {
      report_dir: "reports",
      sandbox_by_mode: { audit: "read-only", linting: "read-only", fixing: "workspace-write" },
    },
    stories: [story],
  };
  writeFileSync(paths.prdFile, `${JSON.stringify(prd, null, 2)}\n`);
  writeFileSync(paths.policyFile, "# Test policy\n");
  const codex = join(fakeBin, "codex");
  writeFileSync(
    codex,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = args[args.indexOf("-C") + 1];
const report = args[args.indexOf("--output-last-message") + 1];
const control = process.env.XDG_DATA_HOME;
const action = fs.readFileSync(path.join(control, "action"), "utf8").trim();
if (action === "retry") {
  const count = path.join(control, "count");
  if (!fs.existsSync(count)) { fs.writeFileSync(count, "1"); console.error("TOKEN=secret-value"); process.exit(7); }
}
if (action === "outside") fs.writeFileSync(path.join(root, "outside.txt"), "blocked\\n");
else if (action === "ignored") fs.writeFileSync(path.join(root, ".env"), "blocked-secret-change\\n");
else if (action !== "preflight") {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "allowed.md"), "provider result\\n");
}
const body = action === "preflight" ? "MODEL_PREFLIGHT_OK\\n"
  : action === "missing-reference" ? "# Report\\nNo sources.\\n"
  : action === "missing-link" ? "# Report\\n\\n## External References\\n\\nChecked 2026-09-07.\\n"
  : action === "missing-date" ? "# Report\\n\\n## External References\\n\\n[Source](https://example.com).\\n"
  : "# Report\\n\\n## External References\\n\\n- [Source](https://example.com) checked 2026-09-07.\\n";
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(report, body);
console.log("provider output");
`,
  );
  chmodSync(codex, 0o755);
  writeFileSync(join(control, "action"), `${action}\n`);
  const options: CliOptions = {
    mode: "fixing",
    maxStoriesExplicit: false,
    search: false,
    timeoutSeconds: 5,
    maxAttempts: 1,
    skipAfterFailures: 0,
    captureToolOutput: false,
    requireExternalReferences: true,
    modelPreflight: false,
    autoArchive: false,
    requireLearningEntry: false,
    syncBranch: false,
    autoProgressLog: false,
    autoSyncAgents: false,
    securityPreflight: false,
    securityPreflightFail: false,
    staleLockSeconds: 30,
    strictReportDir: true,
    autoProgressRefresh: false,
    verbosity: "quiet",
    outputFormat: "text",
    statusFormat: "full",
    listFormat: "full",
    action: "run",
    noColor: true,
  };
  const previousPath = process.env.PATH;
  const previousData = process.env.XDG_DATA_HOME;
  const previousMetadata = process.env.RALPH_TRANSACTION_METADATA_ROOT;
  process.env.PATH = `${fakeBin}:${dirname(process.execPath)}:${previousPath ?? ""}`;
  process.env.XDG_DATA_HOME = control;
  process.env.RALPH_TRANSACTION_METADATA_ROOT = metadata;
  return {
    repo,
    metadata,
    fakeBin,
    control,
    paths,
    prd,
    story,
    options,
    close() {
      process.env.PATH = previousPath;
      if (previousData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousData;
      if (previousMetadata === undefined) delete process.env.RALPH_TRANSACTION_METADATA_ROOT;
      else process.env.RALPH_TRANSACTION_METADATA_ROOT = previousMetadata;
      for (const path of [repo, metadata, fakeBin, control])
        rmSync(path, { recursive: true, force: true });
    },
  };
}

test("promotes in-scope provider output and persists report and PRD state", async () => {
  const item = fixture();
  try {
    const code = await processStory(
      item.paths,
      item.prd,
      item.story,
      "fixing",
      "workspace-write",
      item.options,
      new Logger(item.paths, item.options, true),
    );
    assert.equal(code, 0);
    assert.equal(readFileSync(join(item.repo, "docs", "allowed.md"), "utf8"), "provider result\n");
    assert.match(
      readFileSync(join(item.repo, "reports", "STORY-1.md"), "utf8"),
      /External References/u,
    );
    const persisted = JSON.parse(readFileSync(item.paths.prdFile, "utf8")) as Prd;
    assert.equal(persisted.stories[0]?.passes, true);
    assert.equal(existsSync(item.paths.eventLog), true);
  } finally {
    item.close();
  }
});

test("discards an out-of-scope provider edit without touching the live repository", async () => {
  const item = fixture("outside");
  try {
    await assert.rejects(
      processStory(
        item.paths,
        item.prd,
        item.story,
        "fixing",
        "workspace-write",
        item.options,
        new Logger(item.paths, item.options, true),
      ),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.scope,
    );
    assert.equal(existsSync(join(item.repo, "outside.txt")), false);
    assert.equal(existsSync(join(item.repo, "docs", "allowed.md")), false);
  } finally {
    item.close();
  }
});

test("scope enforcement includes ignored files in the external mirror", async () => {
  const item = fixture("ignored");
  try {
    writeFileSync(join(item.repo, ".env"), "baseline secret\n");
    writeFileSync(join(item.repo, ".gitignore"), ".env\n");
    await assert.rejects(
      processStory(
        item.paths,
        item.prd,
        item.story,
        "fixing",
        "workspace-write",
        item.options,
        new Logger(item.paths, item.options, true),
      ),
      (error: unknown) =>
        error instanceof RalphError &&
        error.exitCode === EXIT.scope &&
        /\.env/u.test(error.message),
    );
    assert.equal(readFileSync(join(item.repo, ".env"), "utf8"), "baseline secret\n");
  } finally {
    item.close();
  }
});

test("retries a failed provider and redacts its raw failure log", async () => {
  const item = fixture("retry");
  try {
    item.options.maxAttempts = 2;
    const code = await processStory(
      item.paths,
      item.prd,
      item.story,
      "fixing",
      "workspace-write",
      item.options,
      new Logger(item.paths, item.options, true),
    );
    assert.equal(code, 0);
    assert.equal(readFileSync(join(item.control, "count"), "utf8"), "1");
    assert.doesNotMatch(readFileSync(item.paths.runLog, "utf8"), /secret-value/u);
    assert.match(readFileSync(item.paths.runLog, "utf8"), /\[REDACTED\]/u);
  } finally {
    item.close();
  }
});

test("enforces the external-reference report contract before promotion", async () => {
  const item = fixture("missing-reference");
  try {
    item.options.search = true;
    const code = await processStory(
      item.paths,
      item.prd,
      item.story,
      "fixing",
      "workspace-write",
      item.options,
      new Logger(item.paths, item.options, true),
    );
    assert.equal(code, 41);
    assert.equal(existsSync(join(item.repo, "docs", "allowed.md")), false);
    assert.equal(existsSync(pointerPath(item.paths)), false);
  } finally {
    item.close();
  }
});

test("distinguishes missing external-reference links and dates", async () => {
  for (const [action, expected] of [
    ["missing-link", 42],
    ["missing-date", 43],
  ] as const) {
    const item = fixture(action);
    try {
      item.options.search = true;
      assert.equal(
        await processStory(
          item.paths,
          item.prd,
          item.story,
          "fixing",
          "workspace-write",
          item.options,
          new Logger(item.paths, item.options, true),
        ),
        expected,
      );
      assert.equal(existsSync(pointerPath(item.paths)), false);
    } finally {
      item.close();
    }
  }
});

test("runs model preflight without applying story changes", async () => {
  const item = fixture("preflight");
  try {
    item.options.modelPreflight = true;
    await modelPreflight(
      item.paths,
      item.options,
      "audit",
      "read-only",
      new Logger(item.paths, item.options, true),
    );
    assert.equal(existsSync(join(item.repo, "docs", "allowed.md")), false);
  } finally {
    item.close();
  }
});

test("required learning enforcement discards the isolated workspace", async () => {
  const item = fixture();
  try {
    item.options.requireLearningEntry = true;
    await assert.rejects(
      processStory(
        item.paths,
        item.prd,
        item.story,
        "fixing",
        "workspace-write",
        item.options,
        new Logger(item.paths, item.options, true),
      ),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.tool,
    );
    assert.equal(existsSync(join(item.repo, "docs", "allowed.md")), false);
    assert.equal(existsSync(pointerPath(item.paths)), false);
  } finally {
    item.close();
  }
});
