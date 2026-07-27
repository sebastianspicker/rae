/** Verifies command evidence exactly matches every role-bound plan command. */
import { describe, expect, it } from "vitest";
import { enforceCommandEvidence } from "../autonomous.mjs";

const plan = {
  verification_commands: [
    {
      command: "npm test",
      working_directory: ".",
      evidence_roles: ["quality-tests"],
      evidence_kind: "tests",
    },
    {
      command: "npm run integration",
      working_directory: ".",
      evidence_roles: ["quality-tests"],
      evidence_kind: "tests",
    },
    {
      command: "git diff --check",
      working_directory: ".",
      evidence_roles: ["quality-static"],
      evidence_kind: "static",
    },
  ],
};

function artifact() {
  return { evidence_bundle: { status: "complete", missing_types: [], residual_gaps: [] } };
}

const successfulEvents = [
  {
    command: "pwd",
    working_directory: ".",
    phase: "quality-tests",
    exit_code: 0,
    successful: true,
  },
  {
    command: "  npm test  ",
    working_directory: ".",
    phase: "quality-tests",
    exit_code: 0,
    successful: true,
  },
  {
    command: "npm run integration",
    working_directory: ".",
    phase: "quality-tests",
    exit_code: 0,
    successful: true,
  },
];

const rejectedEvents = [
    [
      "irrelevant",
      {
        command: "pwd",
        working_directory: ".",
        phase: "quality-tests",
        exit_code: 0,
        successful: true,
      },
    ],
    [
      "failed",
      {
        command: "npm test",
        working_directory: ".",
        phase: "quality-tests",
        exit_code: 1,
        successful: false,
      },
    ],
    [
      "wrong-directory",
      {
        command: "npm test",
        working_directory: "packages/other",
        phase: "quality-tests",
        exit_code: 0,
        successful: true,
      },
    ],
    [
      "wrong-phase",
      {
        command: "npm test",
        working_directory: ".",
        phase: "quality-static",
        exit_code: 0,
        successful: true,
      },
    ],
];

function acceptsExactPlannedCommands() {
  const evidence = enforceCommandEvidence(
    "quality-tests",
    { provider: "codex", commandEventCount: 3, commandEvents: successfulEvents },
    artifact(),
    plan,
  );
  expect(evidence).toMatchObject({
    status: "present",
    successful_command_event_count: 3,
    matched_planned_command_count: 2,
    required_planned_command_count: 2,
  });
}

function rejectsCommandEvidence(_label, event) {
  const report = artifact();
  const evidence = enforceCommandEvidence(
    "quality-tests",
    { provider: "codex", commandEventCount: 1, commandEvents: [event] },
    report,
    plan,
  );
  expect(evidence.status).toBe("missing");
  expect(report.evidence_bundle.status).toBe("partial");
  expect(report.evidence_bundle.residual_gaps.join(" ")).toContain("plan.verification_commands");
}

function requiresEveryTestCommand() {
  const report = artifact();
  const evidence = enforceCommandEvidence(
    "quality-tests",
    {
      provider: "codex",
      commandEventCount: 1,
      commandEvents: [
        {
          command: "npm test",
          working_directory: ".",
          phase: "quality-tests",
          exit_code: 0,
          successful: true,
        },
      ],
    },
    report,
    plan,
  );
  expect(evidence.status).toBe("missing");
}

function rejectsStaticOnlyCommand() {
  const report = artifact();
  const staticOnly = {
    verification_commands: [
      {
        command: "git diff --check",
        working_directory: ".",
        evidence_roles: ["quality-tests"],
        evidence_kind: "static",
      },
    ],
  };
  const evidence = enforceCommandEvidence(
    "quality-tests",
    {
      provider: "codex",
      commandEventCount: 1,
      commandEvents: [
        {
          command: "git diff --check",
          working_directory: ".",
          phase: "quality-tests",
          exit_code: 0,
          successful: true,
        },
      ],
    },
    report,
    staticOnly,
  );
  expect(evidence.status).toBe("missing");
}

function preservesQuotedWhitespace() {
  const report = artifact();
  const quotedPlan = {
    verification_commands: [
      {
        command: 'printf "a  b"',
        working_directory: ".",
        evidence_roles: ["quality-tests"],
        evidence_kind: "tests",
      },
    ],
  };
  const evidence = enforceCommandEvidence(
    "quality-tests",
    {
      provider: "codex",
      commandEventCount: 1,
      commandEvents: [
        {
          command: 'printf "a b"',
          working_directory: ".",
          phase: "quality-tests",
          exit_code: 0,
          successful: true,
        },
      ],
    },
    report,
    quotedPlan,
  );
  expect(evidence.status).toBe("missing");
}

describe("Codex command evidence", () => {
  it(
    "accepts only a successful completed command that exactly matches the approved plan",
    acceptsExactPlannedCommands,
  );
  it.each(rejectedEvents)("rejects %s command evidence", rejectsCommandEvidence);
  it("requires every test-role command rather than accepting one of many", requiresEveryTestCommand);
  it("does not treat a static-only command as quality-test evidence", rejectsStaticOnlyCommand);
  it("preserves whitespace inside quoted command arguments", preservesQuotedWhitespace);
});
