/** Maintained documentation navigation, preserving the source site hierarchy. */
import type { DefaultTheme } from "vitepress";
export const navigation: DefaultTheme.SidebarItem[] = [
  {
    text: "Home",
    link: "/",
  },
  {
    text: "Tutorials",
    items: [
      {
        text: "Graph Engineering with RAE",
        link: "/tutorials/graph-engineering-with-rae",
      },
      {
        text: "Autonomous Code Change",
        link: "/tutorials/autonomous-code-change",
      },
      {
        text: "First Pipeline",
        link: "/tutorials/first-pipeline",
      },
      {
        text: "First Ralph Run",
        link: "/tutorials/first-ralph-run",
      },
      {
        text: "First Profile Install",
        link: "/tutorials/first-profile-install",
      },
    ],
  },
  {
    text: "How-To",
    items: [
      {
        text: "Choose an Execution Model",
        link: "/how-to/choose-an-execution-model",
      },
      {
        text: "Operate the Workflow Engine",
        link: "/how-to/engine-runbook",
      },
      {
        text: "Write a Contract",
        link: "/how-to/write-a-contract",
      },
      {
        text: "Add a Tool",
        link: "/how-to/add-a-tool",
      },
      {
        text: "Publish a Sanitized Profile",
        link: "/how-to/publish-a-sanitized-profile",
      },
      {
        text: "Use the Experimental Hosted API",
        link: "/how-to/hosted-api",
      },
      {
        text: "Run a Workflow 2.2 Wait",
        link: "/how-to/run-workflow-v2.2-wait",
      },
      {
        text: "Deploy the Experimental Platform",
        link: "/how-to/deploy-experimental-platform",
      },
      {
        text: "Recover a Workflow 2.2 Wait",
        link: "/how-to/recover-workflow-v2.2-wait",
      },
    ],
  },
  {
    text: "Reference",
    items: [
      {
        text: "Workflow Rubric",
        link: "/reference/workflow-rubric",
      },
      {
        text: "Repo Map",
        link: "/reference/repo-map",
      },
      {
        text: "Performance Measurements",
        link: "/reference/performance-measurements",
      },
      {
        text: "Terminology",
        link: "/reference/terminology",
      },
      {
        text: "Architecture",
        items: [
          {
            text: "System Overview",
            link: "/reference/architecture/system-overview",
          },
          {
            text: "Module Boundaries",
            link: "/reference/architecture/module-boundaries",
          },
          {
            text: "Experimental Hosted Platform",
            link: "/reference/architecture/experimental-hosted-platform",
          },
        ],
      },
      {
        text: "Contracts",
        items: [
          {
            text: "Artifact Schemas",
            link: "/reference/contracts/artifact-schemas",
          },
          {
            text: "Execution Profile 3.0",
            link: "/reference/contracts/execution-profile-v3",
          },
          {
            text: "Quality Gates",
            link: "/reference/contracts/quality-gates",
          },
          {
            text: "Report Types",
            link: "/reference/contracts/report-types",
          },
          {
            text: "Local Graph and Memory",
            link: "/reference/contracts/graph-memory",
          },
          {
            text: "Workflow 2.2",
            link: "/reference/contracts/workflow-v2.2",
          },
        ],
      },
      {
        text: "CLI",
        items: [
          {
            text: "Umbrella CLI",
            link: "/reference/cli/umbrella",
          },
          {
            text: "Orchestration CLI",
            link: "/reference/cli/orchestration",
          },
          {
            text: "Ralph CLI",
            link: "/reference/cli/ralph",
          },
          {
            text: "Repo Hygiene CLI",
            link: "/reference/cli/repo-hygiene",
          },
        ],
      },
      {
        text: "Engine",
        items: [
          {
            text: "Orchestration Policy",
            link: "/reference/engine/orchestration-policy",
          },
          {
            text: "Adapter Platforms",
            link: "/reference/engine/adapter-platforms",
          },
        ],
      },
      {
        text: "Invariants",
        items: [
          {
            text: "Safety Boundaries",
            link: "/reference/invariants/safety-boundaries",
          },
          {
            text: "Determinism Contracts",
            link: "/reference/invariants/determinism-contracts",
          },
          {
            text: "Provenance Requirements",
            link: "/reference/invariants/provenance-requirements",
          },
        ],
      },
      {
        text: "Claims",
        items: [
          {
            text: "Claims Ledger",
            link: "/reference/claims/claims-ledger",
          },
          {
            text: "Assumptions Register",
            link: "/reference/claims/assumptions-register",
          },
          {
            text: "Bibliography",
            link: "/reference/claims/bibliography",
          },
          {
            text: "Evidence Index",
            link: "/reference/claims/evidence-index",
          },
          {
            text: "Dossiers",
            items: [
              {
                text: "Overview",
                link: "/reference/claims/dossiers/README",
              },
              {
                text: "CLM-002 Documentation Separation",
                link: "/reference/claims/dossiers/clm-002-diataxis-separation",
              },
              {
                text: "CLM-005 Utility Placement",
                link: "/reference/claims/dossiers/clm-005-utility-placement",
              },
              {
                text: "CLM-007 Information Density",
                link: "/reference/claims/dossiers/clm-007-information-density",
              },
              {
                text: "CLM-008 Coordination Topology",
                link: "/reference/claims/dossiers/clm-008-coordination-topology",
              },
              {
                text: "CLM-014 Staged Separation",
                link: "/reference/claims/dossiers/clm-014-staged-separation",
              },
              {
                text: "CLM-016 Cognitive Tiering",
                link: "/reference/claims/dossiers/clm-016-cognitive-tiering",
              },
              {
                text: "CLM-017 Documentation Reliability",
                link: "/reference/claims/dossiers/clm-017-documentation-reliability",
              },
              {
                text: "CLM-020 Layered Failure Model",
                link: "/reference/claims/dossiers/clm-020-layered-failure-model",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    text: "Explanation",
    items: [
      {
        text: "Overview",
        items: [
          {
            text: "Project Scope",
            link: "/explanation/overview/project-scope",
          },
          {
            text: "Decision Tree",
            link: "/explanation/overview/decision-tree",
          },
        ],
      },
      {
        text: "Science",
        items: [
          {
            text: "Abstract",
            link: "/explanation/science/abstract",
          },
          {
            text: "Problem Statement",
            link: "/explanation/science/problem-statement",
          },
          {
            text: "Information Theory",
            link: "/explanation/science/information-theory",
          },
          {
            text: "Coordination Cost",
            link: "/explanation/science/coordination-cost",
          },
          {
            text: "Drift and Self-Certification",
            link: "/explanation/science/drift-and-self-certification",
          },
          {
            text: "Contracts and Gates",
            link: "/explanation/science/contracts-and-gates",
          },
          {
            text: "Cognitive Tiering",
            link: "/explanation/science/cognitive-tiering",
          },
          {
            text: "Threats to Validity",
            link: "/explanation/science/threats-to-validity",
          },
          {
            text: "Limitations",
            link: "/explanation/science/limitations",
          },
        ],
      },
      {
        text: "Supplementary",
        items: [
          {
            text: "Notation",
            link: "/explanation/supplementary/notation",
          },
          {
            text: "Formal Model",
            link: "/explanation/supplementary/formal-model",
          },
          {
            text: "Design Axioms",
            link: "/explanation/supplementary/design-axioms",
          },
          {
            text: "Model of Failure",
            link: "/explanation/supplementary/model-of-failure",
          },
        ],
      },
      {
        text: "Companion",
        items: [
          {
            text: "Workflow State Formalization",
            link: "/explanation/companion/workflow-state-formalization",
          },
          {
            text: "Drift and Error Propagation",
            link: "/explanation/companion/drift-error-propagation",
          },
          {
            text: "Coordination Topologies",
            link: "/explanation/companion/coordination-topologies",
          },
        ],
      },
    ],
  },
  {
    text: "Governance",
    items: [
      {
        text: "Documentation Policy",
        link: "/governance/documentation-policy",
      },
      {
        text: "Quality Policy",
        link: "/governance/quality-policy",
      },
      {
        text: "Citation Policy",
        link: "/governance/citation-policy",
      },
      {
        text: "Source Quality Policy",
        link: "/governance/source-quality-policy",
      },
      {
        text: "Release Criteria",
        link: "/governance/release-criteria",
      },
      {
        text: "Review Checklists",
        link: "/governance/review-checklists",
      },
    ],
  },
  {
    text: "Project",
    items: [
      {
        text: "Changelog",
        link: "https://github.com/sebastianspicker/rae/blob/main/CHANGELOG.md",
      },
      {
        text: "Proposed Release Notes",
        link: "https://github.com/sebastianspicker/rae/blob/main/RELEASE_NOTES.md",
      },
      {
        text: "Release Status",
        link: "https://github.com/sebastianspicker/rae/blob/main/RELEASE_STATUS.md",
      },
      {
        text: "Releasing",
        link: "https://github.com/sebastianspicker/rae/blob/main/RELEASING.md",
      },
      {
        text: "Contributing",
        link: "https://github.com/sebastianspicker/rae/blob/main/CONTRIBUTING.md",
      },
      {
        text: "Security",
        link: "https://github.com/sebastianspicker/rae/blob/main/SECURITY.md",
      },
      {
        text: "Support",
        link: "https://github.com/sebastianspicker/rae/blob/main/SUPPORT.md",
      },
      {
        text: "Governance",
        link: "https://github.com/sebastianspicker/rae/blob/main/GOVERNANCE.md",
      },
      {
        text: "Code of Conduct",
        link: "https://github.com/sebastianspicker/rae/blob/main/CODE_OF_CONDUCT.md",
      },
    ],
  },
  {
    text: "Case Studies",
    items: [
      {
        text: "Phased Orchestration",
        link: "/case-studies/phased-orchestration",
      },
      {
        text: "Ralph Loop",
        link: "/case-studies/ralph-loop",
      },
      {
        text: "Agent Profiles",
        link: "/case-studies/agent-profiles",
      },
      {
        text: "Repo Hygiene Tools",
        link: "/case-studies/repo-hygiene-tools",
      },
    ],
  },
];
