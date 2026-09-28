/** Declares Ralph's persisted, CLI, PRD, and transaction contracts. */
export const MODES = ["audit", "linting", "fixing"] as const;
export type Mode = (typeof MODES)[number];

export interface RalphDefaults {
  mode_default?: Mode;
  model_default?: string;
  reasoning_effort_default?: "low" | "medium" | "high";
  max_stories_default?: number | "all_open";
  report_dir: string;
  sandbox_by_mode: Record<Mode, "read-only" | "workspace-write">;
}

export interface Story {
  id: string;
  title: string;
  priority: number;
  mode: Mode;
  scope: string[];
  acceptance_criteria: string[];
  objective?: string;
  steps?: StoryStep[];
  verification?: string[];
  out_of_scope?: string[];
  notes?: string;
  passes: boolean;
  skipped?: boolean;
  report_path?: string;
  completed_at?: string;
  skip_reason?: string;
  skipped_at?: string;
}

export interface StoryStep {
  id?: string;
  title: string;
  actions: string[];
  expected_evidence: string[];
  done_when: string[];
}

export interface Prd {
  project?: string;
  branch_name?: string;
  branchName?: string;
  defaults: RalphDefaults;
  stories: Story[];
}

export interface CliOptions {
  signal?: AbortSignal;
  mode?: Mode;
  maxStories?: number | "all_open";
  maxStoriesExplicit: boolean;
  search: boolean;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  timeoutSeconds: number;
  maxAttempts: number;
  skipAfterFailures: number;
  captureToolOutput: boolean;
  requireExternalReferences: boolean;
  modelPreflight: boolean;
  autoArchive: boolean;
  requireLearningEntry: boolean;
  syncBranch: boolean;
  autoProgressLog: boolean;
  autoSyncAgents: boolean;
  securityPreflight: boolean;
  securityPreflightFail: boolean;
  staleLockSeconds: number;
  strictReportDir: boolean;
  autoProgressRefresh: boolean;
  verbosity: "normal" | "quiet" | "verbose";
  outputFormat: "text" | "json";
  statusFormat: "full" | "compact" | "json";
  listFormat: "full" | "ids" | "id+title" | "json";
  action:
    | "run"
    | "validate-prd"
    | "validate-config"
    | "check"
    | "doctor"
    | "status"
    | "list-stories"
    | "aggregate-reports"
    | "export-state"
    | "import-state"
    | "reset-story"
    | "retry-failed"
    | "dry-run";
  actionValue?: string;
  noColor: boolean;
}

export interface RuntimePaths {
  packageRoot: string;
  repoRoot: string;
  prdFile: string;
  schemaFile: string;
  policyFile: string;
  stateDir: string;
  runLog: string;
  eventLog: string;
}

export interface ManifestEntry {
  path: string;
  kind: "dir" | "file" | "symlink";
  mode: number;
  size?: number;
  sha256?: string;
  target?: string;
}

export interface Identity {
  device: number;
  inode: number;
}

export interface TransactionOperation {
  path: string;
  before: ManifestEntry[];
  after: ManifestEntry[];
  quarantine?: string;
  staging?: string;
  recovery?: string;
  placement?: "external" | "sibling";
  parent_identity?: Identity;
  state: "pending" | "quarantining" | "quarantined" | "installed" | "recovered" | "conflict";
}

export interface TransactionJournal {
  format: 4;
  id: string;
  state:
    | "mirrored"
    | "prepared"
    | "applying"
    | "recovering"
    | "conflicted"
    | "committed"
    | "recovered";
  root: string;
  runtime: string;
  metadata_root: string;
  mirror: string;
  baseline_store: string;
  quarantine_root: string;
  root_identity: Identity;
  runtime_identity: Identity;
  metadata_root_identity: Identity;
  mirror_identity: Identity;
  baseline_store_identity: Identity;
  baseline: ManifestEntry[];
  prepared: ManifestEntry[] | null;
  changed: string[];
  promoted: string[];
  active: string | null;
  active_started: boolean;
  evidence: TransactionOperation[];
}
