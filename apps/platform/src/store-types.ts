/** Explicit hosted store records keep unconstrained wire JSON outside typed control state. */
export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type NodeState = "queued" | "leased" | "succeeded" | "failed" | "cancelled";
export type Access = "read" | "write";
export type RevisionKind = "workflow" | "profile";
export interface RunRevision {
  digest: string;
  definition: unknown;
}
export interface RunNodeInput {
  key: string;
  payload?: unknown;
  access?: Access;
}
export interface CreateRunInput {
  projectId: string;
  revision: RunRevision;
  nodes?: RunNodeInput[];
  request: unknown;
  idempotencyKey: string;
  traceparent?: string | null;
  repositoryDigest?: string | null;
  worktreeDigest?: string | null;
}
export interface RunView {
  id: string;
  projectId: string;
  state: RunState;
  request: unknown;
  traceparent?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  cancelledAt?: string | Date | null;
}
export interface MemoryRun extends RunView {
  revision: RunRevision;
  repositoryDigest: string | null;
  worktreeDigest: string | null;
  pinnedWorkerId: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string | null;
}
export interface MemoryNode {
  runId: string;
  key: string;
  payload: unknown;
  access: Access;
  state: NodeState;
  attempts: number;
}
export interface WorkerCapabilities {
  repositoryDigest?: string;
  worktreeDigest?: string;
  projects?: string[];
  [key: string]: unknown;
}
export interface RegisterWorkerInput {
  workerId: string;
  repositoryDigest: string;
  worktreeDigest: string;
  capabilities?: WorkerCapabilities;
  projects?: string[];
  idempotencyKey: string;
}
export interface MemoryWorker {
  workerId: string;
  repositoryDigest: string;
  worktreeDigest: string;
  capabilities: WorkerCapabilities;
  projects: string[];
  lastSeenAt: string;
}
export interface ClaimInput {
  workerId: string;
  longPollSeconds?: number;
  projects?: string[];
  idempotencyKey: string;
}
export interface Claim {
  attemptId: string;
  nodeId: string;
  runId: string;
  projectId: string;
  nodeKey: string;
  access: Access;
  payload: unknown;
  fence: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
}
export interface MemoryLease extends Claim {
  workerId: string;
  expiresAt: number;
}
export interface HeartbeatInput {
  projects?: readonly string[];
  workerId: string;
  nodeId: string;
  fence: number | string;
}
export interface ReportInput extends HeartbeatInput {
  outcome: "succeeded" | "failed";
  result?: unknown;
  idempotencyKey: string;
}
export interface ReportResult {
  state: "succeeded" | "failed";
  runState: RunState;
}
export interface CancelInput {
  runId: string;
  idempotencyKey: string;
}
export interface PlatformRevision {
  id: string;
  projectId: string;
  kind: RevisionKind;
  digest: string;
  document: unknown;
  validation: { valid: boolean; errors: string[] };
}
export interface UploadRevisionInput {
  projectId: string;
  kind: RevisionKind;
  document: unknown;
  expectedDigest: string;
  idempotencyKey: string;
}
export interface ActivateRevisionInput {
  projectId: string;
  kind: RevisionKind;
  revisionId: string;
  expectedDigest: string;
  idempotencyKey: string;
}
export interface DiffInput {
  fromId: string;
  toId: string;
}
export interface RebindInput {
  runId: string;
  workerId: string;
  repositoryDigest: string;
  worktreeDigest: string;
  idempotencyKey: string;
}
export interface MemoryEvent {
  id: number;
  type: string;
  payload: unknown;
  traceparent: string | null;
  createdAt: string;
  [key: string]: unknown;
}
export interface OutboxRecord {
  id: number;
  topic: string;
  payload: unknown;
  createdAt: string;
  deliveredAt: string | null;
}
export interface SignalInput {
  runId: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
}
export interface WorkWake {
  notified?: boolean;
  expired?: number;
  cancelled?: boolean;
  failed?: boolean;
}
export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}
export interface PgQuery {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}
export interface PgClient extends PgQuery {
  release(error?: Error): void;
  on(event: "notification", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  off(event: "notification", listener: () => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  __raeNotificationHandlers?: { onNotification: () => void; onError: (error: Error) => void };
}
export interface PgPool extends PgQuery {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
