/** Builds deterministic, mode-aware Codex prompts from validated stories. */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { readRelative } from "./safe-fs.js";
import type { CliOptions, Mode, Prd, RuntimePaths, Story } from "./types.js";

function detectedChecks(repoRoot: string): string[] {
  const checks: string[] = [];
  const packageFile = join(repoRoot, "package.json");
  if (existsSync(packageFile)) {
    try {
      const pkg = JSON.parse(
        readRelative(repoRoot, "package.json", 1024 * 1024).toString("utf8"),
      ) as { scripts?: Record<string, string> };
      const runner = existsSync(join(repoRoot, "pnpm-lock.yaml"))
        ? "pnpm"
        : existsSync(join(repoRoot, "yarn.lock"))
          ? "yarn"
          : "npm";
      if (pkg.scripts?.lint)
        checks.push(
          `[package.json] command: ${runner === "yarn" ? "yarn lint" : `${runner} run lint`}`,
        );
      if (pkg.scripts?.test) checks.push(`[package.json] command: ${runner} test`);
    } catch {
      /* The story can report malformed project metadata. */
    }
  }
  if (
    existsSync(join(repoRoot, "pyproject.toml")) ||
    existsSync(join(repoRoot, "requirements.txt")) ||
    existsSync(join(repoRoot, "requirements-dev.txt"))
  )
    checks.push(
      "[python] command: python3 -m ruff check .",
      "[python] command: python3 -m pytest -q",
    );
  if (existsSync(join(repoRoot, "go.mod"))) checks.push("[go] command: go test ./...");
  if (existsSync(join(repoRoot, "Cargo.toml"))) checks.push("[rust] command: cargo test");
  const makefile = ["Makefile", "makefile", "GNUmakefile"].find((name) =>
    existsSync(join(repoRoot, name)),
  );
  if (makefile) {
    const text = readRelative(repoRoot, makefile, 1024 * 1024).toString("utf8");
    if (/^\s*lint:/mu.test(text)) checks.push("[make] command: make lint");
    if (/^\s*test:/mu.test(text)) checks.push("[make] command: make test");
  }
  return [...new Set(checks)];
}

function list(label: string, values: string[]): string {
  return values.length ? `${label}:\n${values.map((value) => `- ${value}`).join("\n")}\n\n` : "";
}

function steps(story: Story): string {
  if (!story.steps?.length) return "";
  const lines = story.steps.flatMap((step, index) => [
    `- Step ${index + 1} [${step.id || `S${index + 1}`}]: ${step.title}`,
    ...step.actions.map((action) => `  action: ${action}`),
    ...step.expected_evidence.map((evidence) => `  evidence: ${evidence}`),
    ...step.done_when.map((condition) => `  done_when: ${condition}`),
  ]);
  return `Execution steps (detailed):\n${lines.join("\n")}\n\n`;
}

export function buildPrompt(
  paths: RuntimePaths,
  story: Story,
  mode: Mode,
  report: string,
  sandbox: string,
  options: CliOptions,
  toolRoot: string,
): string {
  const guardrails =
    mode === "audit"
      ? [
          "Read-only only. Do not modify repository files.",
          "Produce a findings report with evidence and risk impact.",
        ]
      : mode === "linting"
        ? [
            "Read-only only. Do not modify repository files.",
            "Run best-effort checks from detected commands; if none found, report that explicitly.",
          ]
        : [
            "Write is allowed, but keep fixes minimal, safe, and story-scoped.",
            "No broad refactors, no architecture changes, no security/auth redesign.",
            ...(options.requireLearningEntry
              ? ["This run requires at least one reusable entry in learnings.md."]
              : []),
          ];
  const detected = detectedChecks(toolRoot);
  const checks =
    mode === "audit"
      ? ""
      : `Best-effort check command candidates (auto-detected):\n${detected.length ? detected.map((item) => `- ${item}`).join("\n") : "- No checks auto-detected. Report this explicitly and keep the report valid."}\n\n`;
  const research =
    options.search && options.requireExternalReferences
      ? "External research contract:\n- Include a `## External References` section.\n- Add absolute HTTPS source links.\n- Include accessed dates in ISO format (YYYY-MM-DD).\n\n"
      : "";
  const policyRelative = relative(paths.repoRoot, paths.policyFile).split("\\").join("/");
  const policy = readRelative(toolRoot, policyRelative, 4 * 1024 * 1024).toString("utf8");
  return `# Ralph Story Run\n\nMode: ${mode}\nStory ID: ${story.id}\nTitle: ${story.title}\nOutput report path: ${report}\nSandbox policy: ${sandbox}\n\nToday's UTC date: ${new Date().toISOString().slice(0, 10)}\n\n${list("Scope patterns", story.scope)}${list("Acceptance criteria", story.acceptance_criteria)}${story.objective ? `Story objective:\n${story.objective}\n\n` : ""}${steps(story)}${list("Verification checkpoints", story.verification ?? [])}${list("Out of scope", story.out_of_scope ?? [])}${story.notes ? `Story notes:\n${story.notes}\n\n` : ""}Mode guardrails:\n${[...guardrails, "Never print secrets, tokens, private keys, or raw .env values."].map((item) => `- ${item}`).join("\n")}\n\n${research}${checks}Output contract:\n- Return ONLY the final markdown report body for ${report}\n- Do not include wrapper commentary before or after the markdown report.\n- Keep report deterministic, explicit, and evidence-based.\n\n---\n\n${policy}\n`;
}
