/**
 * Checks governance schemas and fixtures keep multi-model review evidence aligned with repository policy.
 */
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");

function loadSchema(pathFromRepoRoot: string): Record<string, unknown> {
  const fullPath = resolve(repoRoot, pathFromRepoRoot);
  return JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
}

function validateAgainst(schemaPath: string, data: unknown): { valid: boolean; errors: unknown[] } {
  const schema = loadSchema(schemaPath);
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateSchema: false,
    validateFormats: false,
  });
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return { valid, errors: validate.errors ?? [] };
}

const completeSecurityReport = {
  audit_type: "security",
  violations: [],
  summary: { pass: 0, warn: 0, fail: 0, open: 0, fixed: 0, accepted_risk: 0 },
  security_audit: {
    categories_covered: ["access-control", "xss", "csrf", "secrets", "security-headers", "cookies-session", "production-exposure", "dependencies", "ssrf", "file-upload", "injection", "path-traversal", "open-redirect", "jwt-auth"],
    checks: { access_control: true, xss: true, csrf: true, secrets: true, security_headers: true, cookies_session: true, production_exposure: true, dependencies: true, ssrf: true, file_upload: true, injection: true, path_traversal: true, open_redirect: true, jwt_auth: true },
    fix_loop: { rounds: 1, critical_high_before: 2, critical_high_after: 0, rescan_completed: true },
    tools: ["manual"],
    risk_signoff_required: false,
  },
};

describe("governance contract hardening", () => {
  it("rejects security quality reports with incomplete mandatory coverage", () => {
    const report = {
      audit_type: "security",
      violations: [],
      summary: { pass: 0, warn: 0, fail: 0, open: 0, fixed: 0, accepted_risk: 0 },
      security_audit: {
        categories_covered: [
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
        ],
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
          injection: false,
          path_traversal: false,
          open_redirect: false,
          jwt_auth: false,
        },
        fix_loop: {
          rounds: 1,
          critical_high_before: 2,
          critical_high_after: 1,
          rescan_completed: false,
        },
        tools: ["manual"],
        risk_signoff_required: false,
      },
    };

    const result = validateAgainst("contracts/artifacts/quality-report.schema.json", report);
    expect(result.valid).toBe(false);
  });

  it("accepts security quality reports only when mandatory checklist and fix-loop are closed", () => {
    const result = validateAgainst("contracts/artifacts/quality-report.schema.json", completeSecurityReport);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects go release-readiness when changelog or rollback evidence is incomplete", () => {
    const artifact = {
      release_decision: "go",
      semver_impact: "minor",
      changelog: {
        updated: false,
        path: "CHANGELOG.md",
        entries: ["Updated review flow"],
      },
      migration: {
        required: false,
        validated: false,
      },
      rollback: {
        strategy: "Revert commit",
        owner: "release-manager",
        tested: false,
      },
      open_risks: [],
      approvals: [{ owner: "release-manager", approved_at: "2026-02-22T00:00:00Z" }],
    };

    const result = validateAgainst("contracts/artifacts/release-readiness.schema.json", artifact);
    expect(result.valid).toBe(false);
  });

  it("rejects major semver release-readiness when migration is not validated", () => {
    const artifact = {
      release_decision: "go",
      semver_impact: "major",
      changelog: {
        updated: true,
        path: "CHANGELOG.md",
        entries: ["Breaking API migration"],
      },
      migration: {
        required: true,
        doc_path: "docs/migration.md",
        validated: false,
      },
      rollback: {
        strategy: "Revert commit",
        owner: "release-manager",
        tested: true,
      },
      open_risks: [],
      approvals: [{ owner: "release-manager", approved_at: "2026-02-22T00:00:00Z" }],
    };

    const result = validateAgainst("contracts/artifacts/release-readiness.schema.json", artifact);
    expect(result.valid).toBe(false);
  });
});
