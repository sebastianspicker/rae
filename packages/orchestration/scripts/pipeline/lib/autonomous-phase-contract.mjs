/** Defines prompts, gates, ownership, and documentation contracts for autonomous phases. */
import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths } from "./autonomous-git.mjs";
import { readJsonStrict } from "./state.mjs";

export const SCHEMAS = {
  arm: "contracts/artifacts/brief.schema.json",
  design: "contracts/artifacts/design-document.schema.json",
  "adversarial-review": "contracts/artifacts/review-report.schema.json",
  plan: "contracts/artifacts/execution-plan.schema.json",
  pmatch: "contracts/artifacts/drift-report.schema.json",
  build: "contracts/artifacts/build-report.schema.json",
  "quality-static": "contracts/artifacts/quality-report.schema.json",
  "quality-tests": "contracts/artifacts/quality-report.schema.json",
  "post-build": "contracts/artifacts/quality-report.schema.json",
  "release-readiness": "contracts/artifacts/release-readiness.schema.json",
};

const INPUTS = {
  arm: [], design: ["brief.json"], "adversarial-review": ["brief.json", "design.json"],
  plan: ["brief.json", "design.json", "review.json"],
  pmatch: ["brief.json", "design.json", "plan.json"],
  build: ["brief.json", "design.json", "plan.json", "drift-reports/pmatch.json"],
  "quality-static": ["brief.json", "plan.json", "build.json"],
  "quality-tests": ["brief.json", "plan.json", "build.json", "quality-reports/static.json"],
  "post-build": ["brief.json", "design.json", "plan.json", "build.json", "quality-reports/static.json", "quality-reports/tests.json"],
  "release-readiness": ["brief.json", "design.json", "review.json", "plan.json", "drift-reports/pmatch.json", "build.json", "quality-reports/static.json", "quality-reports/tests.json", "quality-reports/post-build.json"],
};

const INSTRUCTIONS = {
  arm: "Inspect the task and repository as a new maintainer. Produce a concrete brief with stable requirement IDs, explicit hard/soft constraints, non-goals, repository conventions, decisions, and no unresolved questions. Make reasonable low-risk assumptions and record them as decisions.",
  design: "Design the smallest implementation that satisfies every MUST requirement. Ground the design in observed repository paths and conventions. Do not invent files or interfaces that you have not inspected. Record the exact codebase-alignment evidence you used.",
  "adversarial-review": "Independently review the brief and design from architecture, security, runtime reliability, documentation, and test perspectives. Fact-check findings against repository code. Deduplicate them and require mitigation for every confirmed critical or high finding.",
  plan: "Produce an executable implementation plan, not prose-only guidance. Every MUST requirement must be covered by at least one task and one test case. file_ownership must enumerate every exact repository-relative file that builders may modify or create, including tests and user-facing docs. verification_commands must use existing repository commands and include working directories. Assign every verification command explicit evidence_roles and an evidence_kind; quality-tests must use actual test commands rather than static-only checks. Populate documentation with an explicit required decision, exact owned paths, and rationale.",
  pmatch: "Check the brief, design, and plan for intent drift before implementation. Claims must cover every MUST requirement and cite concrete evidence. A violated high-severity invariant is a blocking finding; do not hide it behind an average score.",
  build: "Implement the approved plan now. You are a code writer in this phase: edit the target workspace, add or update tests, and update user-facing documentation whenever behavior or an interface changes. Follow plan.documentation exactly and stay strictly inside plan.file_ownership. Run the relevant existing verification commands. Do not merely describe a patch. The build report outputs must list actual changed paths.",
  "quality-static": "Act as an independent read-only quality worker. Inspect the actual Git diff and run the plan's relevant lint, formatting, type, compile, and static-analysis commands. Record each failure as an open violation with reproducible path/evidence. Do not claim a pass for a command you did not execute; distinguish unavailable tooling as a warning. Populate evidence_bundle with every executed verification command and its concrete report or result reference.",
  "quality-tests": "Act as an independent read-only test worker. Execute the planned focused tests and the broadest practical documented test gate. Record exact failing tests and commands as open violations. All executed required tests must exit successfully for summary.fail and summary.open to be zero. Populate evidence_bundle with every executed test command and its concrete result reference.",
  "post-build": "Perform a final implementation, documentation, and security audit over the actual diff. You may make only small corrective edits inside plan.file_ownership, then rerun affected tests. Check that public behavior is documented and that no debug leftovers, secrets, path traversal, injection, unsafe cleanup, or unbounded runtime behavior remains. Use audit_type security and record fixed and residual findings honestly. Populate evidence_bundle with the final commands and repository paths used to reach the audit decision. Set user_surface true on evidence for every public behavior and confirm the corresponding plan.documentation paths changed.",
  "release-readiness": "Assess the completed local change using only recorded artifacts and the actual diff. RAE exposes no commit, push, publish, or deploy action. Use release_decision conditional when human review or unavailable verification remains, and list each condition. Document changelog, migration, rollback, evidence, residual gaps, and approval provenance honestly.",
};

export function phaseArtifacts(runDir, phase, policy) {
  const inputs = {};
  for (const ref of policy?.phase_inputs?.[phase] ?? INPUTS[phase] ?? []) {
    const path = resolve(runDir, ref);
    if (existsSync(path)) inputs[ref] = readJsonStrict(path);
  }
  return inputs;
}

function repositoryPromptPath(pathValue, workspaceRoot) {
  if (!workspaceRoot || typeof pathValue !== "string") return pathValue;
  const canonicalRoot = resolve(workspaceRoot);
  const absolutePath = resolve(pathValue);
  const relation = relative(canonicalRoot, absolutePath);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  ) {
    return relation ? relation.replaceAll("\\", "/") : ".";
  }
  return "<absolute-path-omitted>";
}

const QUOTED_ABSOLUTE_PATH =
  /(["'`])((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/|\/)[^"'`]+?)\1/giu;
const ANGLED_ABSOLUTE_PATH =
  /<((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/|\/)[^>]+)>/giu;
const ABSOLUTE_PATH_TOKEN =
  /(^|[^A-Za-z0-9._~+:\/\\-])((?:file:\/\/[^\s"'`<>)\],;{}]+|[A-Za-z]:[\\/][^\s"'`<>)\],;{}]+|\\\\[^\s"'`<>)\],;{}]+|\/\/[^\s"'`<>)\],;{}]+|\/(?!\/)[^\s"'`<>)\],;{}]+))/giu;

function absolutePathValue(value) {
  return /^(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/|\/)/iu.test(value);
}

function sanitizeUrlValue(value, workspaceRoot) {
  if (absolutePathValue(value)) return sanitizePathToken(value, workspaceRoot);
  const assignment = value.match(
    /^(.*?=)((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/|\/).*)$/iu,
  );
  if (assignment) {
    return `${assignment[1]}${sanitizePathToken(assignment[2], workspaceRoot)}`;
  }
  return sanitizePromptString(value, workspaceRoot);
}

function sanitizeUrlSearch(search, workspaceRoot) {
  if (!search) return "";
  const direct = sanitizePromptString(search, workspaceRoot);
  if (direct !== search) return direct;
  const params = new URLSearchParams(search);
  let changed = false;
  for (const [key, value] of [...params.entries()]) {
    const sanitized = sanitizeUrlValue(value, workspaceRoot);
    if (sanitized === value) continue;
    params.set(key, sanitized);
    changed = true;
  }
  return changed ? `?${params.toString()}` : search;
}

function sanitizeUrlHash(hash, workspaceRoot) {
  if (!hash) return "";
  const raw = hash.slice(1);
  const direct = sanitizeUrlValue(raw, workspaceRoot);
  if (direct !== raw) return `#${direct}`;
  try {
    const decoded = decodeURIComponent(raw);
    const sanitized = sanitizeUrlValue(decoded, workspaceRoot);
    return sanitized === decoded ? hash : `#${encodeURIComponent(sanitized)}`;
  } catch {
    return hash;
  }
}

function sanitizeFileUrl(token, workspaceRoot) {
  try {
    const url = new URL(token);
    const suffix = `${sanitizeUrlSearch(url.search, workspaceRoot)}${sanitizeUrlHash(url.hash, workspaceRoot)}`;
    url.search = "";
    url.hash = "";
    return `${repositoryPromptPath(fileURLToPath(url), workspaceRoot)}${suffix}`;
  } catch {
    return "<absolute-path-omitted>";
  }
}

function sanitizePathTokenCore(token, workspaceRoot) {
  if (/^file:\/\//i.test(token)) return sanitizeFileUrl(token, workspaceRoot);
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(token)) {
    const normalizedRoot = resolve(workspaceRoot).replaceAll("\\", "/");
    const normalizedToken = token.replaceAll("\\", "/");
    if (/^[A-Za-z]:\//.test(normalizedRoot)) {
      return repositoryPromptPath(normalizedToken, normalizedRoot);
    }
    return "<absolute-path-omitted>";
  }
  return repositoryPromptPath(token, workspaceRoot);
}

function sanitizePathToken(token, workspaceRoot) {
  const punctuation = token.match(/^(.*?)([.!?]+)$/u);
  if (!punctuation) return sanitizePathTokenCore(token, workspaceRoot);
  return `${sanitizePathTokenCore(punctuation[1], workspaceRoot)}${punctuation[2]}`;
}

function sanitizePromptString(value, workspaceRoot) {
  if (!workspaceRoot || typeof value !== "string") return value;
  return value
    .replace(
      QUOTED_ABSOLUTE_PATH,
      (_match, quote, token) => `${quote}${sanitizePathToken(token, workspaceRoot)}${quote}`,
    )
    .replace(
      ANGLED_ABSOLUTE_PATH,
      (_match, token) => `<${sanitizePathToken(token, workspaceRoot)}>`,
    )
    .replace(
      ABSOLUTE_PATH_TOKEN,
      (_match, prefix, token) => `${prefix}${sanitizePathToken(token, workspaceRoot)}`,
    );
}

function sanitizePromptInputs(value, workspaceRoot) {
  if (typeof value === "string") return sanitizePromptString(value, workspaceRoot);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePromptInputs(item, workspaceRoot));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      sanitizePromptString(key, workspaceRoot),
      sanitizePromptInputs(item, workspaceRoot),
    ]),
  );
}

export function buildPrompt({ phase, task, runId, inputs, policy, workspaceRoot }) {
  const readOnly = !["build", "post-build"].includes(phase);
  const guidance = policy?.phase_guidance?.[phase]?.trim();
  const promptInputs = sanitizePromptInputs(inputs, workspaceRoot);
  const promptTask = sanitizePromptString(task, workspaceRoot);
  const promptGuidance = guidance ? sanitizePromptString(guidance, workspaceRoot) : "";
  return `You are executing one phase of the RAE autonomous coding-agent pipeline.\n\nRun: ${runId}\nPhase: ${phase}\nWorkspace: current working directory\nMutation mode: ${readOnly ? "read-only" : "workspace-write"}\n\nUser task:\n${promptTask}\n\nPhase-scoped predecessor artifacts:\n${JSON.stringify(promptInputs, null, 2)}\n\nPhase objective:\n${INSTRUCTIONS[phase]}\n\n${promptGuidance ? `Validated policy guidance:\n${promptGuidance}\n` : ""}Mandatory operating rules:\n- Read the repository's applicable instructions and inspect relevant source before deciding.\n- Stay inside the workspace. Never commit, push, publish, deploy, or alter Git remotes.\n- Do not install dependencies or use networked infrastructure. Report missing tools as evidence.\n- Never read or print secrets, credentials, environment files, tokens, or private key material.\n- ${readOnly ? "Do not modify any repository file in this phase." : "Modify only plan-owned files and never write under .pipeline/."}\n- Treat documentation as a product surface: behavior and interface changes require corresponding docs.\n- Populate context_manifest honestly with repository-relative files actually used; docs_loaded may be empty.\n- Return only the JSON object required by the supplied output schema. Do not wrap it in Markdown.\n`;
}

function ownedPath(path, ownedPaths) {
  return ownedPaths.some((owned) => path === owned || (owned.endsWith("/**") && path.startsWith(owned.slice(0, -2))) || (owned.endsWith("/") && path.startsWith(owned)));
}

function safePlanPath(path) {
  if (!validPlanPathText(path)) return false;
  const normalized = path.replaceAll("\\", "/");
  if (isAbsolute(path)) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  if (invalidWildcard(normalized)) return false;
  const concrete = normalized.endsWith("/**") ? normalized.slice(0, -3) : normalized;
  const segments = concrete.split("/");
  return validPlanSegments(segments);
}

function validPlanPathText(path) { return typeof path === "string" && Boolean(path) && !path.includes("\0"); }
function invalidWildcard(path) { return path.includes("*") && !path.endsWith("/**"); }
function validPlanSegments(segments) { return !segments.some(invalidPlanSegment) && ![".git", ".pipeline"].includes(segments[0]); }
function invalidPlanSegment(part) { return !part || part === "." || part === ".."; }

function docsPath(path) {
  const lower = path.toLowerCase();
  const name = basename(lower);
  return name === "readme" || name.startsWith("readme.") || name === "changelog" || name.startsWith("changelog.") || lower.startsWith("docs/") || /\.(?:md|mdx|rst|adoc)$/.test(lower);
}

export function documentationAssessment(plan, outputs, buildExecuted = true) {
  const contract = plan?.documentation ?? null;
  const changed = outputs.filter(docsPath);
  if (!contract) return documentationResult(null, "undecided", changed);
  if (!contract.required) return documentationResult(contract, changed.length ? "updated" : "not-required", changed);
  if (!buildExecuted) return documentationResult(contract, "planned", changed);
  const missing = contract.paths.filter((item) => !changed.some((actual) => ownedPath(actual, [item])));
  return documentationResult(contract, missing.length ? "missing" : "updated", changed, missing);
}

function documentationResult(contract, status, changed, missing = []) {
  return { required: contract?.required ?? null, status, expected_paths: contract?.paths ?? [], changed_files: changed, missing_paths: missing, rationale: contract?.rationale ?? "The plan did not contain an autonomous documentation contract." };
}

export function gateStatusForArtifact(phase, artifact) {
  const evaluator = phaseGateEvaluator(phase);
  if (evaluator) return evaluator(artifact);
  return artifact.release_decision === "no-go" ? "fail" : artifact.release_decision === "conditional" ? "warn" : "pass";
}

function phaseGateEvaluator(phase) { return { arm: armGate, "adversarial-review": reviewGate, pmatch: pmatchGate, plan: planGate, "quality-static": qualityGate, "quality-tests": qualityGate, "post-build": qualityGate }[phase]; }
function armGate(artifact) { return (artifact.open_questions?.length ?? 0) ? "fail" : "pass"; }

function reviewGate(artifact) {
  const mitigated = new Set((artifact.mitigations ?? []).filter((item) => item.status === "mitigated").map((item) => item.finding_id));
  return (artifact.deduplicated_findings ?? []).some((item) => ["critical", "high"].includes(item.severity) && !mitigated.has(item.id)) ? "fail" : "pass";
}

function pmatchGate(artifact) {
  const violated = (artifact.claims ?? []).some((item) => item.verification_status === "violated");
  const highFinding = (artifact.findings ?? []).some((item) => ["critical", "high"].includes(item.severity));
  return violated || highFinding ? "fail" : "pass";
}

function planGate(artifact) {
  const owned = Object.keys(artifact.file_ownership ?? {});
  const docs = artifact.documentation;
  const invalidDocs = docs?.required && (!(docs.paths?.length) || docs.paths.some((item) => !safePlanPath(item) || !ownedPath(item, owned)));
  return !docs || owned.some((item) => !safePlanPath(item)) || invalidDocs ? "fail" : "pass";
}

function qualityGate(artifact) {
  const evidence = artifact.evidence_bundle;
  if (missingQualityEvidence(evidence)) return "fail";
  if (failedQualitySummary(artifact.summary)) return "fail";
  return warnedQualitySummary(evidence, artifact.summary) ? "warn" : "pass";
}

function missingQualityEvidence(evidence) { return !evidence || evidence.status === "missing" || (evidence.status === "complete" && !evidence.references?.length); }
function failedQualitySummary(summary = {}) { return (summary.fail ?? 0) > 0 || (summary.open ?? 0) > 0; }
function warnedQualitySummary(evidence, summary = {}) { return evidence.status === "partial" || (summary.warn ?? 0) > 0 || (summary.accepted_risk ?? 0) > 0; }

export function ownershipAssessment(plan, workspaceRoot, artifact) {
  const actual = changedPaths(workspaceRoot);
  const unauthorized = actual.filter((item) => !ownedPath(item, Object.keys(plan.file_ownership ?? {})));
  const documentation = documentationAssessment(plan, actual);
  const errors = [...(actual.length ? [] : ["build produced no repository changes"]), ...unauthorized.map((item) => `path is outside plan.file_ownership: ${item}`), ...documentation.missing_paths.map((item) => `required documentation path did not change: ${item}`)];
  artifact.outputs = actual.length ? actual : ["<no-files-changed>"];
  if (errors.length) artifact.groups = [{ group_id: "runtime-ownership-check", status: "fail", tasks_completed: 0, tasks_total: 1, errors }];
  return { status: errors.length ? "fail" : "pass", actualOutputs: actual, unauthorized, documentation };
}

export function postBuildOwnership(plan, workspaceRoot, artifact) {
  const actual = changedPaths(workspaceRoot);
  const unauthorized = actual.filter((item) => !ownedPath(item, Object.keys(plan.file_ownership ?? {})));
  const documentation = documentationAssessment(plan, actual);
  if (!unauthorized.length && !documentation.missing_paths.length) return { status: "pass", actualOutputs: actual, unauthorized, documentation };
  artifact.violations = [...(artifact.violations ?? []), ...ownershipViolations(unauthorized, documentation.missing_paths)];
  artifact.summary = { ...(artifact.summary ?? {}), fail: Math.max(1, artifact.summary?.fail ?? 0), open: Math.max(unauthorized.length + documentation.missing_paths.length, artifact.summary?.open ?? 0) };
  return { status: "fail", actualOutputs: actual, unauthorized, documentation };
}

function ownershipViolations(unauthorized, missing) {
  return [...unauthorized.map((file) => ({ rule: "plan-file-ownership", severity: "high", file, evidence: "Changed path is absent from plan.file_ownership", remediation: "Revert the path or add it through a reviewed plan revision", status: "open", category: "path-traversal" })), ...missing.map((file) => ({ rule: "required-documentation", severity: "high", file, evidence: "The plan requires this user-facing documentation path, but it did not change", remediation: "Update the planned documentation path before release readiness", status: "open", category: "production-exposure" }))];
}

export function normalizeReleaseArtifact(artifact) {
  if (artifact.release_decision !== "no-go") {
    artifact.release_decision = "conditional";
    artifact.conditions = [...new Set([...(artifact.conditions ?? []), "A human must inspect the diff and approve any commit, push, publication, or release."])];
  }
  artifact.approvals = [{ owner: "rae-autonomous-runtime", approved_at: new Date().toISOString(), notes: "Approval covers local pipeline execution only; it is not release authorization." }];
  artifact.review_loop_ref = "review-loop.json";
  artifact.review_state = { explain_status: "completed", fix_status: "completed", ship_status: "pending-approval" };
  return artifact;
}
