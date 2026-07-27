/**
 * Builds deterministic quality and release artifacts without coupling their large fixtures to phase routing.
 */

export function buildQualityArtifact(auditType) {
  const coverageLedger =
    auditType === "tests"
      ? {
          coverage_scope: "must-requirements",
          requirements: [
            {
              requirement_id: "REQ-001",
              planned_task_ids: ["task-1"],
              planned_test_cases: ["runner-stage-smoke"],
              acceptance_criteria: ["trace events emitted", "gate output persisted"],
              missing_task_ids: [],
              missing_test_cases: [],
              status: "covered",
            },
          ],
          summary: {
            total_requirements: 1,
            covered_requirements: 1,
            partial_requirements: 0,
            missing_requirements: 0,
          },
        }
      : undefined;
  const securityAudit =
    auditType === "security"
      ? {
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
            "injection",
            "path-traversal",
            "open-redirect",
            "jwt-auth",
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
          tools: ["deterministic-fixture"],
          risk_signoff_required: false,
        }
      : undefined;
  return {
    audit_type: auditType,
    violations: [],
    summary: { pass: 1, warn: 0, fail: 0, open: 0, fixed: 0, accepted_risk: 0 },
    ...(coverageLedger ? { coverage_ledger: coverageLedger } : {}),
    ...(coverageLedger
      ? {
          qc_summary: {
            headline: "All MUST requirements map to planned tests.",
            coverage_status: "complete",
            covered_requirements: ["REQ-001"],
            missing_requirement_ids: [],
          },
        }
      : {}),
    ...(securityAudit ? { security_audit: securityAudit } : {}),
  };
}

export function buildReleaseReadinessArtifact({ now }) {
  return {
    release_decision: "go",
    semver_impact: "minor",
    changelog: {
      updated: true,
      path: "README.md",
      entries: ["Runner and evaluation harness upgraded"],
    },
    migration: {
      required: false,
      validated: true,
    },
    rollback: {
      strategy: "revert runner changes",
      owner: "platform",
      tested: true,
    },
    open_risks: [],
    review_loop_ref: "review-loop.json",
    review_state: {
      explain_status: "completed",
      fix_status: "completed",
      ship_status: "approved",
    },
    approvals: [{ owner: "release-lead", approved_at: now, notes: "automated taskset run" }],
  };
}
