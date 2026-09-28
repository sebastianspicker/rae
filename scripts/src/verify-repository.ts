/** Preserve public documentation metadata, source density and portable asset contracts. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";
import {
  validateBrandSvg,
  validateSocialPreviewPng,
  validateTerminalSvg,
} from "./validate-assets.js";

export const publicRootMarkdown = [
  "README.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "RELEASING.md",
  "RELEASE_NOTES.md",
  "RELEASE_STATUS.md",
  "SECURITY.md",
  "SUPPORT.md",
];
const screenshots = ["rae-agent-safety", "rae-cli"].map(
  (name) => `docs/assets/screenshots/${name}.svg`,
);
const brand = ["rae-mark", "rae-lockup-light", "rae-lockup-dark", "rae-social-preview"].map(
  (name) => `docs/assets/brand/${name}.svg`,
);
const diagrams = [
  "graph-edge-classification",
  "diamond-versus-pipeline",
  "routing-and-quorum",
  "until-dry-convergence",
  "human-activated-workflow-lifecycle",
].map((name) => `docs/assets/diagrams/${name}.svg`);
export const requiredFiles = [
  ...publicRootMarkdown,
  "CITATION.cff",
  "LICENSE",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ...["bug-report", "config", "documentation", "feature-request"].map(
    (name) => `.github/ISSUE_TEMPLATE/${name}.yml`,
  ),
  ".github/release.yml",
  ...screenshots,
  ...brand,
  ...diagrams,
  "docs/assets/brand/rae-social-preview.png",
  "docs/stylesheets/brand.css",
  "docs/.vitepress/config.ts",
  "package-lock.json",
  "scripts/src/verify.ts",
  "scripts/src/verify-repository.ts",
  "scripts/src/check-source.ts",
  "docs/INDEX.md",
  "docs/reference/claims/claims-ledger.md",
  "profiles/agent-environments/README.md",
];
export function validateFrontmatter(source: string, path: string): void {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${path} is missing frontmatter start`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new Error(`${path} is missing frontmatter end`);
  const keys = new Set(
    normalized
      .slice(4, end)
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => line.split(":", 1)[0].trim()),
  );
  const missing = ["status", "owner", "last_reviewed", "source_of_truth"].filter(
    (key) => !keys.has(key),
  );
  if (missing.length) throw new Error(`${path} is missing frontmatter keys: ${missing.join(", ")}`);
}
export function validateSourceDensity(source: string, path: string): void {
  if (!/^docs\/(?:explanation\/(?:research|science)|reference\/claims\/dossiers)\//.test(path))
    return;
  const count = new Set(source.match(/bibliography\.md#src-[A-Za-z0-9._-]+/g)).size;
  if (count < 7) throw new Error(`${path} has ${count} external sources; minimum is 7`);
}
export function obsoletePublicArtifacts(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      /^(?:archive|docs\/(?:agent|archive))(?:\/|$)/.test(path) ||
      (!path.includes("/") && /^(?:.*AUDIT.*|PLAN.*|REMEDIATION.*|STATUS.*)\.MD$/i.test(path)),
  );
}
export function validateReleaseState(status: Buffer, tracked: ReadonlySet<string>): void {
  if (status.length) throw new Error("Release candidate Git worktree is not clean");
  const missing = requiredFiles.filter((path) => !tracked.has(path));
  if (missing.length)
    throw new Error(`Release-required files are not tracked: ${missing.join(", ")}`);
}
export function verifyRepository(releaseCandidate = false): void {
  const missing = requiredFiles.filter((path) => !existsSync(resolve(repositoryRoot, path)));
  if (missing.length) throw new Error(`Missing required files: ${missing.join(", ")}`);
  const paths = repositoryFiles();
  if (releaseCandidate)
    validateReleaseState(
      execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        cwd: repositoryRoot,
      }),
      new Set(repositoryFiles(true)),
    );
  const obsolete = obsoletePublicArtifacts(paths);
  if (obsolete.length) throw new Error(`Obsolete public artifacts remain: ${obsolete.join(", ")}`);
  for (const path of paths.filter(
    (path) =>
      path.startsWith("docs/") && path.endsWith(".md") && !/^docs\/(?:agent|archive)\//.test(path),
  )) {
    const source = readFileSync(resolve(repositoryRoot, path), "utf8");
    validateFrontmatter(source, path);
    validateSourceDensity(source, path);
  }
  for (const path of screenshots)
    validateTerminalSvg(readFileSync(resolve(repositoryRoot, path), "utf8"), path);
  for (const path of [...brand, ...diagrams])
    validateBrandSvg(readFileSync(resolve(repositoryRoot, path), "utf8"), path);
  validateSocialPreviewPng(
    readFileSync(resolve(repositoryRoot, "docs/assets/brand/rae-social-preview.png")),
    "docs/assets/brand/rae-social-preview.png",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some((flag) => flag !== "--release-candidate"))
      throw new Error("Usage: verify-repository [--release-candidate]");
    verifyRepository(flags.includes("--release-candidate"));
    console.log("PASS: public metadata and assets");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
