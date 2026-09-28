/** PostgreSQL artifact policy locks runs, leases, and reservations in lifecycle order. */
import type {
  ArtifactOwner,
  ArtifactRecord,
  ArtifactStore,
  VerificationRequest,
} from "./artifacts.js";
export interface SqlResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<SqlResult>;
}
export interface TransactionDatabase extends SqlClient {
  transaction<T>(action: (client: SqlClient) => Promise<T>): Promise<T>;
}
const projection = `id,run_id AS "runId",object_key AS "objectKey",state,object_version_id AS "objectVersionId",expected_sha256 AS "expectedSha256",expected_size_bytes AS "expectedSizeBytes"`;
const clearClaim =
  "verification_claim_id=NULL,verification_claimed_at=NULL,verification_claim_expires_at=NULL";
function conflict(): never {
  throw Object.assign(
    new Error("artifact reservation is not owned by an active fenced attempt or claim"),
    { statusCode: 409 },
  );
}
function field(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid artifact database field: ${key}`);
  return value;
}
function artifact(result: SqlResult): ArtifactRecord {
  const row = result.rows[0];
  if (!row) return conflict();
  const size = row.expectedSizeBytes;
  if (size !== null && size !== undefined && typeof size !== "string" && typeof size !== "number")
    throw new Error("Invalid artifact size field");
  return {
    id: field(row, "id"),
    runId: field(row, "runId"),
    objectKey: field(row, "objectKey"),
    state: field(row, "state"),
    objectVersionId: row.objectVersionId == null ? null : field(row, "objectVersionId"),
    expectedSha256: row.expectedSha256 == null ? undefined : field(row, "expectedSha256"),
    expectedSizeBytes: size ?? undefined,
  };
}
/** Called again after all potentially blocking locks; clock_timestamp prevents stale expiry checks. */
async function activeLease(
  client: SqlClient,
  owner: ArtifactOwner,
): Promise<{ runId: string; attemptId: string }> {
  const result = await client.query(
    `SELECT n.run_id,t.id AS attempt_id FROM leases l
    JOIN run_nodes n ON n.id=l.node_id JOIN runs r ON r.id=n.run_id
    JOIN workers w ON w.id=l.worker_id JOIN attempts t ON t.node_id=l.node_id AND t.worker_id=l.worker_id AND t.fence=l.fence
    WHERE l.node_id=$1 AND l.worker_id=$2 AND l.fence=$3 AND l.expires_at>clock_timestamp()
      AND n.state='leased' AND t.state='running' AND r.state IN ('queued','running') AND r.cancelled_at IS NULL
      AND (((w.capabilities->'projects') ? '*') OR ((w.capabilities->'projects') ? r.project_id))
      AND ($4::text[] IS NULL OR '*'=ANY($4) OR r.project_id=ANY($4))`,
    [owner.nodeId, owner.workerId, owner.fence, owner.projects ?? null],
  );
  const row = result.rows[0];
  if (!row) return conflict();
  return { runId: field(row, "run_id"), attemptId: field(row, "attempt_id") };
}
async function lockOwner(client: SqlClient, owner: ArtifactOwner): Promise<void> {
  const run = await client.query(
    "SELECT r.id FROM runs r JOIN run_nodes n ON n.run_id=r.id WHERE n.id=$1 FOR UPDATE OF r",
    [owner.nodeId],
  );
  if (!run.rowCount) conflict();
  const lease = await client.query(
    "SELECT node_id FROM leases WHERE node_id=$1 AND worker_id=$2 AND fence=$3 FOR UPDATE",
    [owner.nodeId, owner.workerId, owner.fence],
  );
  if (!lease.rowCount) conflict();
}
async function lockReservation(client: SqlClient, request: VerificationRequest): Promise<void> {
  await lockOwner(client, request);
  const result = await client.query("SELECT id FROM artifacts WHERE id=$1 FOR UPDATE", [
    request.id,
  ]);
  if (!result.rowCount) conflict();
}
function claimValues(request: VerificationRequest & { claimId: string }): unknown[] {
  return [request.id, request.sha256, request.sizeBytes, request.fence, request.claimId];
}
export class PostgresArtifactStore implements ArtifactStore {
  constructor(private readonly database: TransactionDatabase) {}
  async abandonArtifactReservation(request: ArtifactOwner & { id: string }): Promise<void> {
    await this.database.query(
      `UPDATE artifacts a SET state='rejected',rejected_at=clock_timestamp()
      FROM attempts t WHERE a.id=$1 AND a.attempt_id=t.id AND a.fence=$4 AND t.node_id=$2 AND t.worker_id=$3 AND t.fence=$4
      AND a.state='reserved' AND a.verification_claim_id IS NULL`,
      [request.id, request.nodeId, request.workerId, request.fence],
    );
  }
  async reserveArtifact(
    request: Parameters<ArtifactStore["reserveArtifact"]>[0],
  ): Promise<ArtifactRecord> {
    return this.database.transaction(async (client) => {
      await lockOwner(client, request);
      const owner = await activeLease(client, request);
      return artifact(
        await client.query(
          `INSERT INTO artifacts (id,run_id,attempt_id,fence,object_key,state,expected_sha256,expected_size_bytes)
        VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7) RETURNING ${projection}`,
          [
            request.artifactId,
            owner.runId,
            owner.attemptId,
            request.fence,
            request.objectKey,
            request.expectedSha256,
            request.expectedSizeBytes,
          ],
        ),
      );
    });
  }
  async claimArtifactVerification(
    request: Parameters<ArtifactStore["claimArtifactVerification"]>[0],
  ) {
    if (
      !Number.isSafeInteger(request.claimSeconds) ||
      request.claimSeconds < 1 ||
      request.claimSeconds > 300
    )
      throw new Error("Invalid verification claim duration");
    return this.database.transaction(async (client) => {
      await lockReservation(client, request);
      const owner = await activeLease(client, request);
      const result = await client.query(
        `UPDATE artifacts SET verification_claim_id=$5,verification_claimed_at=clock_timestamp(),
        verification_claim_expires_at=clock_timestamp()+($7::integer * interval '1 second'),verification_attempts=verification_attempts+1
        WHERE id=$1 AND state='reserved' AND expected_sha256=$2 AND expected_size_bytes=$3 AND fence=$4 AND attempt_id=$6
          AND (verification_claim_id IS NULL OR verification_claim_expires_at<=clock_timestamp()) RETURNING ${projection}`,
        [...claimValues(request), owner.attemptId, request.claimSeconds],
      );
      return { ...artifact(result), claimId: request.claimId };
    });
  }
  async verifyArtifact(
    request: Parameters<ArtifactStore["verifyArtifact"]>[0],
  ): Promise<ArtifactRecord> {
    if (!request.objectVersionId) conflict();
    return this.database.transaction(async (client) => {
      await lockReservation(client, request);
      const owner = await activeLease(client, request);
      return artifact(
        await client.query(
          `UPDATE artifacts SET state='verified',sha256=$2,size_bytes=$3,object_version_id=$7,
        verified_at=clock_timestamp(),${clearClaim} WHERE id=$1 AND state='reserved' AND expected_sha256=$2 AND expected_size_bytes=$3
        AND fence=$4 AND verification_claim_id=$5 AND attempt_id=$6 AND verification_claim_expires_at>clock_timestamp() RETURNING ${projection}`,
          [...claimValues(request), owner.attemptId, request.objectVersionId],
        ),
      );
    });
  }
  async rejectArtifactVerification(
    request: Parameters<ArtifactStore["rejectArtifactVerification"]>[0],
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      await lockReservation(client, request);
      const owner = await activeLease(client, request);
      const result = await client.query(
        `UPDATE artifacts SET state='rejected',quarantine_key=$7,rejected_at=clock_timestamp(),${clearClaim}
        WHERE id=$1 AND state='reserved' AND expected_sha256=$2 AND expected_size_bytes=$3 AND fence=$4
          AND verification_claim_id=$5 AND attempt_id=$6 AND verification_claim_expires_at>clock_timestamp()`,
        [...claimValues(request), owner.attemptId, request.quarantineKey],
      );
      if (!result.rowCount) conflict();
    });
  }
  async releaseArtifactVerification(
    request: Parameters<ArtifactStore["releaseArtifactVerification"]>[0],
  ): Promise<void> {
    await this.database.query(
      `UPDATE artifacts SET ${clearClaim} WHERE id=$1 AND state='reserved' AND verification_claim_id=$2`,
      [request.id, request.claimId],
    );
  }
}
