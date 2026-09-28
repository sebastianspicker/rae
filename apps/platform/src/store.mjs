/** Purpose: transactional PostgreSQL and in-memory control-plane primitives. */
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const id = () => crypto.randomUUID();
const json = (value) => JSON.stringify(value);
export const MAX_ENVELOPE_BYTES = 256 * 1024;
export const RUN_STATE = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
});
export const NODE_STATE = Object.freeze({
  QUEUED: "queued",
  LEASED: "leased",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
});
export const TERMINAL_RUN_STATES = Object.freeze([
  RUN_STATE.SUCCEEDED,
  RUN_STATE.FAILED,
  RUN_STATE.CANCELLED,
]);
export const TERMINAL_NODE_STATES = Object.freeze([
  NODE_STATE.SUCCEEDED,
  NODE_STATE.FAILED,
  NODE_STATE.CANCELLED,
]);
const MAX_LONG_POLL_SECONDS = 25;
function storeClosedError() {
  return Object.assign(new Error("store is shutting down"), { statusCode: 503 });
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
    this.workWaiters = new Set();
    this.workSubscribers = new Set();
    this.notificationClient = null;
    this.notificationClientPromise = null;
    this.releasedNotificationClients = new WeakSet();
    this.closed = false;
    this.closePromise = null;
  }
  static connect(url) {
    const { Pool } = require("pg");
    return new PostgresStore(new Pool({ connectionString: url }));
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.beginShutdown();
    this.closePromise = (async () => {
      try {
        await this.closeNotificationListener();
      } finally {
        await this.pool.end();
      }
    })();
    return this.closePromise;
  }

  beginShutdown() {
    if (this.closed) return;
    this.closed = true;
    this.signalLocalWork({ cancelled: true });
  }

  signalLocalWork(message = { notified: true, expired: 0 }) {
    for (const wake of [...this.workWaiters]) wake(message);
    for (const subscriber of [...this.workSubscribers]) subscriber(message);
  }

  async ensureNotificationListener() {
    if (this.closed) throw storeClosedError();
    if (this.notificationClient) return this.notificationClient;
    if (!this.notificationClientPromise) {
      const starting = (async () => {
        const client = await this.pool.connect();
        if (this.closed) {
          this.releaseNotificationClient(client);
          throw storeClosedError();
        }
        const onNotification = () => this.signalLocalWork({ notified: true, expired: 0 });
        const onError = (error) => {
          if (this.notificationClient === client) this.notificationClient = null;
          this.notificationClientPromise = null;
          this.releaseNotificationClient(client, error);
          this.signalLocalWork({ notified: true, expired: 0 });
        };
        client.on("notification", onNotification);
        client.on("error", onError);
        try {
          await client.query("LISTEN rae_platform_work");
        } catch (error) {
          client.off("notification", onNotification);
          client.off("error", onError);
          client.release();
          throw error;
        }
        client.__raeNotificationHandlers = { onNotification, onError };
        if (this.closed) {
          this.releaseNotificationClient(client);
          throw storeClosedError();
        }
        this.notificationClient = client;
        return client;
      })();
      const guarded = starting.catch((error) => {
        if (this.notificationClientPromise === guarded) this.notificationClientPromise = null;
        throw error;
      });
      this.notificationClientPromise = guarded;
    }
    return this.notificationClientPromise;
  }

  releaseNotificationClient(client, error = null) {
    if (!client || this.releasedNotificationClients.has(client)) return;
    this.releasedNotificationClients.add(client);
    const handlers = client.__raeNotificationHandlers;
    if (handlers) {
      client.off("notification", handlers.onNotification);
      client.off("error", handlers.onError);
    }
    client.release(error || undefined);
  }

  async closeNotificationListener() {
    const starting = this.notificationClientPromise;
    let client = this.notificationClient;
    if (!client && starting) {
      try {
        client = await starting;
      } catch {
        client = null;
      }
    }
    this.notificationClient = null;
    this.notificationClientPromise = null;
    if (!client) return;
    try {
      await client.query("UNLISTEN rae_platform_work");
    } catch {
      /* A broken listener is still released and the pool is closed. */
    } finally {
      this.releaseNotificationClient(client);
    }
  }

  createWorkWaiter(timeoutMs) {
    let timer;
    let settled = false;
    let resolveWait;
    const promise = new Promise((resolve) => {
      resolveWait = resolve;
    });
    const finish = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.workWaiters.delete(finish);
      resolveWait(message);
    };
    this.workWaiters.add(finish);
    timer = setTimeout(() => finish({ notified: false, expired: 0 }), Math.max(0, timeoutMs));
    return { promise, cancel: () => finish({ cancelled: true }) };
  }
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async idempotentTransaction(scope, idempotencyKey, operation) {
    if (!idempotencyKey)
      throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400 });
    const composite = `${scope}:${idempotencyKey}`;
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [composite]);
      const prior = await client.query("SELECT response FROM idempotency_keys WHERE key=$1", [
        composite,
      ]);
      if (prior.rowCount) return prior.rows[0].response;
      const response = await operation(client);
      await client.query(
        "INSERT INTO idempotency_keys (key,scope,response) VALUES ($1,$2,$3::jsonb)",
        [composite, scope, json(response)],
      );
      return response;
    });
  }
  async query(text, values) {
    return this.pool.query(text, values);
  }
  async isReady() {
    const result = await this.query("SELECT version FROM schema_migrations");
    return ["001_initial.sql", "002_artifact_fencing.sql", "003_hosted_v2.sql"].every((version) =>
      result.rows.some((row) => row.version === version),
    );
  }
  async migrate(version, sql) {
    await this.transaction(async (client) => {
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      );
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
        version,
      ]);
      if (!applied.rowCount) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      }
    });
  }
  async createRun({
    projectId,
    revision,
    nodes = [],
    request,
    idempotencyKey,
    traceparent,
    repositoryDigest = null,
    worktreeDigest = null,
  }) {
    if (!idempotencyKey)
      throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400 });
    if (Buffer.byteLength(JSON.stringify({ revision, nodes, request })) > MAX_ENVELOPE_BYTES)
      throw Object.assign(new Error("run envelope exceeds 256 KiB"), { statusCode: 413 });
    return this.transaction(async (client) => {
      const scope = `run:${projectId}:${idempotencyKey}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scope]);
      if (idempotencyKey) {
        const prior = await client.query("SELECT response FROM idempotency_keys WHERE key = $1", [
          scope,
        ]);
        if (prior.rowCount) return prior.rows[0].response;
      }
      const actualDigest = digest(revision.definition);
      if (actualDigest !== revision.digest)
        throw Object.assign(new Error("run revision digest mismatch"), { statusCode: 409 });
      const revisionId = id();
      const runId = id();
      await client.query(
        "INSERT INTO revisions (id, project_id, digest, definition) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (project_id,digest) DO NOTHING",
        [revisionId, projectId, revision.digest, json(revision.definition)],
      );
      const revisionRow = await client.query(
        "SELECT id FROM revisions WHERE project_id=$1 AND digest=$2",
        [projectId, revision.digest],
      );
      await client.query(
        "INSERT INTO runs (id,project_id,revision_id,state,request,traceparent,repository_digest,worktree_digest) VALUES ($1,$2,$3,'queued',$4::jsonb,$5,$6,$7)",
        [
          runId,
          projectId,
          revisionRow.rows[0].id,
          json(request),
          traceparent,
          repositoryDigest,
          worktreeDigest,
        ],
      );
      for (const node of nodes)
        await client.query(
          "INSERT INTO run_nodes (id,run_id,node_key,state,payload,access) VALUES ($1,$2,$3,'queued',$4::jsonb,$5)",
          [id(), runId, node.key, json(node.payload || {}), node.access || "read"],
        );
      const response = { id: runId, state: "queued" };
      await client.query(
        "INSERT INTO events (run_id,type,payload,traceparent) VALUES ($1,'run.queued',$2::jsonb,$3)",
        [runId, json(response), traceparent],
      );
      await client.query("INSERT INTO outbox (topic,payload) VALUES ('run.queued',$1::jsonb)", [
        json({ runId, traceparent }),
      ]);
      await client.query("SELECT pg_notify('rae_platform_work','work')");
      if (idempotencyKey)
        await client.query(
          "INSERT INTO idempotency_keys (key,scope,response) VALUES ($1,$2,$3::jsonb)",
          [scope, "run", json(response)],
        );
      return response;
    });
  }
  async uploadRevision({ projectId, kind, document, expectedDigest, idempotencyKey }) {
    const actual = digest(document);
    if (actual !== expectedDigest)
      throw Object.assign(new Error("revision digest mismatch"), { statusCode: 409 });
    const validation = {
      valid: kind === "profile" || Array.isArray(document.nodes),
      errors:
        kind === "profile" || Array.isArray(document.nodes)
          ? []
          : ["workflow.nodes must be an array"],
    };
    if (!validation.valid)
      throw Object.assign(new Error(validation.errors[0]), { statusCode: 400 });
    return this.idempotentTransaction(
      `revision:${projectId}:${kind}`,
      idempotencyKey,
      async (client) => {
        const revisionId = id();
        const result = await client.query(
          "INSERT INTO platform_revisions (id,project_id,kind,digest,document,validation) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT (project_id,kind,digest) DO UPDATE SET digest=EXCLUDED.digest RETURNING id,digest,validation",
          [revisionId, projectId, kind, actual, json(document), json(validation)],
        );
        return result.rows[0];
      },
    );
  }
  async getRevision(id) {
    const result = await this.query(
      'SELECT id,project_id AS "projectId",kind,digest,document,validation FROM platform_revisions WHERE id=$1',
      [id],
    );
    return result.rows[0] || null;
  }
  async diffRevisions({ fromId, toId }) {
    const [from, to] = await Promise.all([this.getRevision(fromId), this.getRevision(toId)]);
    if (!from || !to || from.kind !== to.kind || from.projectId !== to.projectId)
      throw Object.assign(new Error("comparable revisions not found"), { statusCode: 404 });
    return {
      from: from.digest,
      to: to.digest,
      changed: canonical(from.document) !== canonical(to.document),
    };
  }
  async activateRevision({ projectId, kind, revisionId, expectedDigest, idempotencyKey }) {
    return this.idempotentTransaction(
      `activate:${projectId}:${kind}`,
      idempotencyKey,
      async (client) => {
        const found = await client.query(
          'SELECT id,project_id AS "projectId",kind,digest FROM platform_revisions WHERE id=$1',
          [revisionId],
        );
        const revision = found.rows[0];
        if (
          !revision ||
          revision.projectId !== projectId ||
          revision.kind !== kind ||
          revision.digest !== expectedDigest
        )
          throw Object.assign(new Error("exact revision digest confirmation required"), {
            statusCode: 409,
          });
        await client.query(
          "INSERT INTO active_revisions (project_id,kind,revision_id,digest) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id,kind) DO UPDATE SET revision_id=EXCLUDED.revision_id,digest=EXCLUDED.digest,activated_at=now()",
          [projectId, kind, revisionId, expectedDigest],
        );
        return { revisionId, digest: expectedDigest };
      },
    );
  }
  async notifyWork() {
    await this.query("SELECT pg_notify('rae_platform_work','work')");
  }
  async reclaimExpired(client) {
    const expired = await client.query(
      `WITH expired AS (
         SELECT node_id
         FROM leases
         WHERE expires_at <= clock_timestamp()
         ORDER BY expires_at,node_id
         FOR UPDATE SKIP LOCKED
         LIMIT 100
       )
       DELETE FROM leases l USING expired e
       WHERE l.node_id=e.node_id
       RETURNING l.node_id`,
    );
    const nodeIds = expired.rows.map((row) => row.node_id);
    if (!nodeIds.length) return 0;
    await client.query(
      "UPDATE attempts SET state='expired',finished_at=now() WHERE state='running' AND node_id = ANY($1::uuid[])",
      [nodeIds],
    );
    await client.query(
      "UPDATE run_nodes SET state='queued' WHERE state='leased' AND id = ANY($1::uuid[])",
      [nodeIds],
    );
    await client.query("SELECT pg_notify('rae_platform_work','reclaimed')");
    return nodeIds.length;
  }
  async reconcile() {
    return this.transaction((client) => this.reclaimExpired(client));
  }
  async startReconciler(onWake = () => {}) {
    await this.ensureNotificationListener();
    this.workSubscribers.add(onWake);
    const timer = setInterval(async () => {
      try {
        const expired = await this.reconcile();
        onWake({ notified: false, expired });
      } catch {
        onWake({ notified: false, expired: 0, failed: true });
      }
    }, 30_000);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      this.workSubscribers.delete(onWake);
    };
  }
  async registerWorker({
    workerId,
    repositoryDigest,
    worktreeDigest,
    capabilities = {},
    projects = [],
    idempotencyKey,
  }) {
    const effective = { ...capabilities, repositoryDigest, worktreeDigest, projects };
    return this.idempotentTransaction(`register:${workerId}`, idempotencyKey, async (client) => {
      await client.query(
        "INSERT INTO workers (id,capabilities) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET capabilities=EXCLUDED.capabilities,last_seen_at=now()",
        [workerId, json(effective)],
      );
      return { workerId, repositoryDigest, worktreeDigest, projects };
    });
  }
  async signalRun({ runId, kind, payload, idempotencyKey }) {
    return this.idempotentTransaction(`signal:${runId}`, idempotencyKey, async (client) => {
      const result = await client.query(
        "INSERT INTO signals (id,run_id,kind,payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING id,kind,payload",
        [id(), runId, kind, json(payload)],
      );
      await client.query("INSERT INTO events (run_id,type,payload) VALUES ($1,$2,$3::jsonb)", [
        runId,
        `signal.${kind}`,
        json(payload),
      ]);
      return result.rows[0];
    });
  }
  async cancelRun({ runId, idempotencyKey }) {
    return this.idempotentTransaction(`cancel:${runId}`, idempotencyKey, async (client) => {
      const locked = await client.query("SELECT id,state FROM runs WHERE id=$1 FOR UPDATE", [
        runId,
      ]);
      if (!locked.rowCount || ![RUN_STATE.QUEUED, RUN_STATE.RUNNING].includes(locked.rows[0].state))
        throw Object.assign(new Error("run cannot be cancelled"), { statusCode: 409 });
      const result = await client.query(
        "UPDATE runs SET state='cancelled',cancelled_at=now(),updated_at=now() WHERE id=$1 RETURNING id,state,cancelled_at AS \"cancelledAt\"",
        [runId],
      );
      const cancelledLeases = await client.query(
        "DELETE FROM leases WHERE node_id IN (SELECT id FROM run_nodes WHERE run_id=$1) RETURNING node_id",
        [runId],
      );
      const nodeIds = cancelledLeases.rows.map((row) => row.node_id);
      if (nodeIds.length) {
        await client.query(
          "UPDATE attempts SET state='expired',finished_at=now() WHERE state='running' AND node_id = ANY($1::uuid[])",
          [nodeIds],
        );
      }
      await client.query(
        "UPDATE run_nodes SET state='cancelled' WHERE run_id=$1 AND state IN ('queued','leased')",
        [runId],
      );
      const payload = {
        runId,
        state: RUN_STATE.CANCELLED,
        completedAt: result.rows[0].cancelledAt,
      };
      await client.query(
        "INSERT INTO events (run_id,type,payload) VALUES ($1,'run.cancelled',$2::jsonb)",
        [runId, json(payload)],
      );
      await client.query("INSERT INTO outbox (topic,payload) VALUES ('run.cancelled',$1::jsonb)", [
        json(payload),
      ]);
      await client.query("SELECT pg_notify('rae_platform_work','cancelled')");
      return result.rows[0];
    });
  }
  async rebindRun({ runId, workerId, repositoryDigest, worktreeDigest, idempotencyKey }) {
    return this.idempotentTransaction(`rebind:${runId}`, idempotencyKey, async (client) => {
      const worker = await client.query("SELECT capabilities FROM workers WHERE id=$1", [workerId]);
      const identity = worker.rows[0]?.capabilities || {};
      if (
        identity.repositoryDigest !== repositoryDigest ||
        identity.worktreeDigest !== worktreeDigest
      )
        throw Object.assign(new Error("matching repository and worktree digests are required"), {
          statusCode: 409,
        });
      const result = await client.query(
        'UPDATE runs SET pinned_worker_id=$2 WHERE id=$1 AND repository_digest=$3 AND worktree_digest=$4 RETURNING id,pinned_worker_id AS "workerId"',
        [runId, workerId, repositoryDigest, worktreeDigest],
      );
      if (!result.rowCount)
        throw Object.assign(new Error("matching repository and worktree digests are required"), {
          statusCode: 409,
        });
      return result.rows[0];
    });
  }
  async getRun(runId) {
    const result = await this.query(
      'SELECT id,project_id AS "projectId",state,request,traceparent,created_at AS "createdAt",updated_at AS "updatedAt",cancelled_at AS "cancelledAt" FROM runs WHERE id=$1',
      [runId],
    );
    return result.rows[0] || null;
  }
  async listRunEvents(runId) {
    const result = await this.query(
      'SELECT id,type,payload,traceparent,created_at AS "createdAt" FROM events WHERE run_id=$1 ORDER BY id',
      [runId],
    );
    return result.rows;
  }
  async listRunEventsAfter(runId, afterId = 0, limit = 100) {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 100)));
    const cursor =
      Number.isSafeInteger(Number(afterId)) && Number(afterId) >= 0 ? Number(afterId) : 0;
    const result = await this.query(
      'SELECT id,type,payload,traceparent,created_at AS "createdAt" FROM events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT $3',
      [runId, cursor, boundedLimit],
    );
    return result.rows;
  }
  async metricsSnapshot() {
    const result = await this.query(
      'SELECT (SELECT count(*) FROM run_nodes WHERE state=\'queued\')::int AS "queueDepth", 0::int AS "activeWaits", COALESCE(EXTRACT(EPOCH FROM now()-max(last_seen_at)),0)::float AS "workerFreshnessSeconds", (SELECT count(*) FROM outbox WHERE delivered_at IS NULL)::int AS "outboxPending" FROM workers',
    );
    const snapshot = result.rows[0] || {};
    snapshot.activeWaits = this.workWaiters.size;
    return snapshot;
  }
  async claimOnce({ workerId, projects, idempotencyKey, persistEmpty }) {
    if (this.closed) throw storeClosedError();
    const scope = `claim:${workerId}:${idempotencyKey}`;
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scope]);
      const prior = await client.query("SELECT response FROM idempotency_keys WHERE key=$1", [
        scope,
      ]);
      if (prior.rowCount) return { found: true, response: prior.rows[0].response };
      const workerResult = await client.query(
        "SELECT capabilities FROM workers WHERE id=$1 FOR UPDATE",
        [workerId],
      );
      if (!workerResult.rowCount)
        throw Object.assign(new Error("worker must register before claiming"), { statusCode: 409 });
      const worker = workerResult.rows[0].capabilities;
      const wildcard = projects.includes("*");
      const permittedProjects = wildcard
        ? worker.projects || []
        : projects.filter((project) => worker.projects?.includes(project));
      if (!wildcard && !permittedProjects.length) {
        if (persistEmpty)
          await client.query(
            "INSERT INTO idempotency_keys (key,scope,response) VALUES ($1,'claim','null'::jsonb)",
            [scope],
          );
        return { found: persistEmpty, response: null };
      }
      const candidate = await client.query(
        `
        SELECT n.id,n.run_id,n.node_key,n.payload,n.attempt_count,n.access
        FROM run_nodes n
        JOIN runs r ON r.id=n.run_id
        WHERE n.state='queued'
          AND r.state IN ('queued','running')
          AND ($2::boolean OR r.project_id = ANY($3::text[]))
          AND (r.pinned_worker_id IS NULL OR r.pinned_worker_id=$1)
          AND (r.repository_digest IS NULL OR r.repository_digest=$4)
          AND (r.worktree_digest IS NULL OR r.worktree_digest=$5)
          AND NOT EXISTS (
            SELECT 1 FROM leases l JOIN run_nodes active ON active.id=l.node_id
            WHERE active.run_id=n.run_id AND l.expires_at > clock_timestamp() AND (
              n.access='write' OR active.access='write' OR
              (SELECT count(*) FROM leases readers JOIN run_nodes reader_node ON reader_node.id=readers.node_id WHERE reader_node.run_id=n.run_id AND reader_node.access='read' AND readers.expires_at > clock_timestamp()) >= 4
            )
          )
        ORDER BY n.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
        [workerId, wildcard, permittedProjects, worker.repositoryDigest, worker.worktreeDigest],
      );
      if (!candidate.rowCount) {
        if (persistEmpty)
          await client.query(
            "INSERT INTO idempotency_keys (key,scope,response) VALUES ($1,'claim','null'::jsonb)",
            [scope],
          );
        return { found: persistEmpty, response: null };
      }
      const node = candidate.rows[0];
      const fence = Number(node.attempt_count) + 1;
      const leased = await client.query(
        "UPDATE run_nodes SET state='leased',attempt_count=$2 WHERE id=$1 AND state='queued' RETURNING id",
        [node.id, fence],
      );
      if (!leased.rowCount) return { found: false, response: null };
      await client.query(
        "INSERT INTO leases (node_id,worker_id,fence,expires_at) VALUES ($1,$2,$3,now() + interval '60 seconds')",
        [node.id, workerId, fence],
      );
      const attemptId = id();
      await client.query(
        "INSERT INTO attempts (id,node_id,worker_id,fence,state) VALUES ($1,$2,$3,$4,'running')",
        [attemptId, node.id, workerId, fence],
      );
      const pin = await client.query(
        "UPDATE runs SET state='running',updated_at=now(),pinned_worker_id=COALESCE(pinned_worker_id,$2) WHERE id=$1 AND state IN ('queued','running') AND (pinned_worker_id IS NULL OR pinned_worker_id=$2)",
        [node.run_id, workerId],
      );
      if (pin.rowCount !== 1)
        throw Object.assign(new Error("run is pinned to another worker"), { statusCode: 409 });
      const run = await client.query("SELECT project_id FROM runs WHERE id=$1", [node.run_id]);
      const response = {
        attemptId,
        nodeId: node.id,
        runId: node.run_id,
        projectId: run.rows[0].project_id,
        nodeKey: node.node_key,
        access: node.access,
        payload: node.payload,
        fence,
        leaseSeconds: 60,
        heartbeatSeconds: 20,
      };
      await client.query(
        "INSERT INTO idempotency_keys (key,scope,response) VALUES ($1,'claim',$2::jsonb)",
        [scope, json(response)],
      );
      return { found: true, response };
    });
  }
  async claim({ workerId, longPollSeconds = 0, projects = [], idempotencyKey }) {
    if (!idempotencyKey)
      throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400 });
    if (this.closed) throw storeClosedError();
    const waitSeconds = Math.min(MAX_LONG_POLL_SECONDS, Math.max(0, longPollSeconds || 0));
    const deadline = Date.now() + waitSeconds * 1000;
    while (true) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs > 0) await this.ensureNotificationListener();
      const waiter = remainingMs > 0 ? this.createWorkWaiter(remainingMs) : null;
      try {
        if (this.closed) {
          waiter?.cancel();
          throw storeClosedError();
        }
        const attempt = await this.claimOnce({
          workerId,
          projects,
          idempotencyKey,
          persistEmpty: remainingMs === 0,
        });
        if (attempt.found) {
          waiter?.cancel();
          return attempt.response;
        }
        if (!waiter) continue;
        const wake = await waiter.promise;
        if (wake.cancelled || this.closed) throw storeClosedError();
      } catch (error) {
        waiter?.cancel();
        throw error;
      }
    }
  }
  async heartbeat({ workerId, nodeId, fence }) {
    const result = await this.transaction(async (client) => {
      const owned = await client.query(
        "SELECT l.node_id FROM leases l JOIN run_nodes n ON n.id=l.node_id JOIN runs r ON r.id=n.run_id JOIN workers w ON w.id=l.worker_id WHERE l.node_id=$1 AND l.worker_id=$2 AND l.fence=$3 AND (((w.capabilities->'projects') ? '*') OR ((w.capabilities->'projects') ? r.project_id)) FOR UPDATE OF l",
        [nodeId, workerId, fence],
      );
      if (!owned.rowCount)
        throw Object.assign(new Error("lease missing, expired, or fenced"), { statusCode: 409 });
      const renewed = await client.query(
        "UPDATE leases SET heartbeat_at=clock_timestamp(),expires_at=clock_timestamp() + interval '60 seconds' WHERE node_id=$1 AND expires_at > clock_timestamp() RETURNING expires_at AS \"expiresAt\"",
        [nodeId],
      );
      if (!renewed.rowCount)
        throw Object.assign(new Error("lease missing, expired, or fenced"), { statusCode: 409 });
      return renewed.rows[0];
    });
    await this.query("UPDATE workers SET last_seen_at=now() WHERE id=$1", [workerId]);
    return result;
  }
  async report({ workerId, nodeId, fence, outcome, result = {}, idempotencyKey }) {
    if (!idempotencyKey)
      throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400 });
    return this.transaction(async (client) => {
      const scope = `report:${nodeId}:${idempotencyKey}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scope]);
      const prior = await client.query("SELECT response FROM idempotency_keys WHERE key=$1", [
        scope,
      ]);
      if (prior.rowCount) return prior.rows[0].response;
      const runResult = await client.query(
        "SELECT r.id,r.state FROM run_nodes n JOIN runs r ON r.id=n.run_id WHERE n.id=$1 FOR UPDATE OF r",
        [nodeId],
      );
      if (
        !runResult.rowCount ||
        ![RUN_STATE.QUEUED, RUN_STATE.RUNNING].includes(runResult.rows[0].state)
      )
        throw Object.assign(new Error("run is no longer active"), { statusCode: 409 });
      const runId = runResult.rows[0].id;
      const ownedLease = await client.query(
        "SELECT l.node_id FROM leases l JOIN run_nodes n ON n.id=l.node_id JOIN runs r ON r.id=n.run_id JOIN workers w ON w.id=l.worker_id WHERE l.node_id=$1 AND l.worker_id=$2 AND l.fence=$3 AND (((w.capabilities->'projects') ? '*') OR ((w.capabilities->'projects') ? r.project_id)) FOR UPDATE OF l",
        [nodeId, workerId, fence],
      );
      if (!ownedLease.rowCount)
        throw Object.assign(new Error("lease missing, expired, or fenced"), { statusCode: 409 });
      const lease = await client.query(
        "DELETE FROM leases WHERE node_id=$1 AND expires_at > clock_timestamp() RETURNING node_id",
        [nodeId],
      );
      if (!lease.rowCount)
        throw Object.assign(new Error("lease missing, expired, or fenced"), { statusCode: 409 });
      const state = outcome === RUN_STATE.SUCCEEDED ? NODE_STATE.SUCCEEDED : NODE_STATE.FAILED;
      const nodeUpdate = await client.query(
        "UPDATE run_nodes SET state=$2 WHERE id=$1 AND state='leased' RETURNING run_id",
        [nodeId, state],
      );
      const attemptUpdate = await client.query(
        "UPDATE attempts SET state=$4,finished_at=now(),result=$5::jsonb WHERE node_id=$1 AND worker_id=$2 AND fence=$3 AND state='running' RETURNING id",
        [nodeId, workerId, fence, state, json(result)],
      );
      if (nodeUpdate.rowCount !== 1 || attemptUpdate.rowCount !== 1)
        throw Object.assign(new Error("attempt completion lost its fence"), { statusCode: 409 });
      await client.query("INSERT INTO events (run_id,type,payload) VALUES ($1,$2,$3::jsonb)", [
        runId,
        `node.${state}`,
        json({ runId, nodeId, fence, result }),
      ]);
      await client.query("INSERT INTO outbox (topic,payload) VALUES ($1,$2::jsonb)", [
        `node.${state}`,
        json({ runId, nodeId, fence, result }),
      ]);
      const aggregate = await client.query(
        "SELECT count(*) FILTER (WHERE state NOT IN ('succeeded','failed','cancelled'))::int AS active, bool_or(state='failed') AS failed FROM run_nodes WHERE run_id=$1",
        [runId],
      );
      let runState = RUN_STATE.RUNNING;
      if (aggregate.rows[0].active === 0) {
        runState = aggregate.rows[0].failed ? RUN_STATE.FAILED : RUN_STATE.SUCCEEDED;
        const terminal = await client.query(
          "UPDATE runs SET state=$2,updated_at=now() WHERE id=$1 AND state IN ('queued','running') RETURNING updated_at AS \"completedAt\"",
          [runId, runState],
        );
        if (terminal.rowCount !== 1)
          throw Object.assign(new Error("run completion lost its active state"), {
            statusCode: 409,
          });
        const terminalPayload = {
          runId,
          state: runState,
          completedAt: terminal.rows[0].completedAt,
        };
        await client.query("INSERT INTO events (run_id,type,payload) VALUES ($1,$2,$3::jsonb)", [
          runId,
          `run.${runState}`,
          json(terminalPayload),
        ]);
        await client.query("INSERT INTO outbox (topic,payload) VALUES ($1,$2::jsonb)", [
          `run.${runState}`,
          json(terminalPayload),
        ]);
      } else {
        await client.query("UPDATE runs SET updated_at=now() WHERE id=$1", [runId]);
      }
      await client.query("SELECT pg_notify('rae_platform_work','reported')");
      const response = { state, runState };
      await client.query(
        "INSERT INTO idempotency_keys (key,scope,response) VALUES ($1,'report',$2::jsonb)",
        [scope, json(response)],
      );
      return response;
    });
  }
  async reserveArtifact({ workerId, nodeId, fence, objectKey, expectedSha256, expectedSizeBytes }) {
    return this.transaction(async (client) => {
      const lease = await client.query(
        "SELECT n.run_id,a.id AS attempt_id FROM leases l JOIN run_nodes n ON n.id=l.node_id JOIN runs r ON r.id=n.run_id JOIN workers w ON w.id=l.worker_id JOIN attempts a ON a.node_id=l.node_id AND a.worker_id=l.worker_id AND a.fence=l.fence AND a.state='running' WHERE l.node_id=$1 AND l.worker_id=$2 AND l.fence=$3 AND l.expires_at > now() AND (((w.capabilities->'projects') ? '*') OR ((w.capabilities->'projects') ? r.project_id)) FOR UPDATE OF l",
        [nodeId, workerId, fence],
      );
      if (!lease.rowCount)
        throw Object.assign(new Error("artifact reservation requires an active fenced lease"), {
          statusCode: 409,
        });
      const artifact = { id: id(), runId: lease.rows[0].run_id, objectKey, state: "reserved" };
      await client.query(
        "INSERT INTO artifacts (id,run_id,attempt_id,fence,object_key,state,expected_sha256,expected_size_bytes) VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7)",
        [
          artifact.id,
          artifact.runId,
          lease.rows[0].attempt_id,
          fence,
          objectKey,
          expectedSha256,
          expectedSizeBytes,
        ],
      );
      return artifact;
    });
  }
  async getArtifact(artifactId) {
    const result = await this.query(
      'SELECT id,run_id AS "runId",object_key AS "objectKey",object_version_id AS "objectVersionId",state,expected_sha256 AS "expectedSha256",expected_size_bytes AS "expectedSizeBytes" FROM artifacts WHERE id=$1',
      [artifactId],
    );
    return result.rows[0] || null;
  }
  async verifyArtifact({
    id: artifactId,
    sha256,
    sizeBytes,
    workerId,
    nodeId,
    fence,
    objectVersionId,
  }) {
    const result = await this.query(
      "UPDATE artifacts a SET state='verified',sha256=$2,size_bytes=$3,object_version_id=$7,verified_at=now() FROM attempts t JOIN leases l ON l.node_id=t.node_id AND l.worker_id=t.worker_id AND l.fence=t.fence WHERE a.id=$1 AND a.state='reserved' AND a.attempt_id=t.id AND t.worker_id=$4 AND t.node_id=$5 AND t.fence=$6 AND l.expires_at > now() RETURNING a.id,a.object_key AS \"objectKey\",a.object_version_id AS \"objectVersionId\",a.state",
      [artifactId, sha256, sizeBytes, workerId, nodeId, fence, objectVersionId],
    );
    if (!result.rowCount)
      throw Object.assign(
        new Error("artifact reservation is not owned by an active fenced attempt"),
        { statusCode: 409 },
      );
    return result.rows[0];
  }
}

export class MemoryStore {
  constructor({ now = () => Date.now() } = {}) {
    this.runs = new Map();
    this.nodes = new Map();
    this.leases = new Map();
    this.artifacts = new Map();
    this.keys = new Map();
    this.pendingKeys = new Map();
    this.events = new Map();
    this.outbox = [];
    this.revisions = new Map();
    this.active = new Map();
    this.workers = new Map();
    this.workWaiters = new Set();
    this.runLocks = new Map();
    this.now = now;
    this.closed = false;
    this.schemaCurrent = true;
  }
  beginShutdown() {
    if (this.closed) return;
    this.closed = true;
    this.notifyWork({ cancelled: true });
  }
  async close() {
    this.beginShutdown();
  }
  async isReady() {
    return this.schemaCurrent;
  }
  async idempotent(scope, key, operation) {
    if (!key) throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400 });
    const composite = `${scope}:${key}`;
    if (this.keys.has(composite)) return this.keys.get(composite);
    if (this.pendingKeys.has(composite)) return this.pendingKeys.get(composite);
    const pending = (async () => {
      const result = await operation();
      this.keys.set(composite, result);
      return result;
    })();
    this.pendingKeys.set(composite, pending);
    try {
      return await pending;
    } finally {
      this.pendingKeys.delete(composite);
    }
  }
  async withRunLock(runId, operation) {
    const previous = this.runLocks.get(runId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.runLocks.set(runId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.runLocks.get(runId) === current) this.runLocks.delete(runId);
    }
  }
  timestamp() {
    return new Date(this.now()).toISOString();
  }
  appendEvent(runId, type, payload, traceparent = null, createdAt = this.timestamp()) {
    const events = this.events.get(runId);
    if (!events) return null;
    const event = {
      id: (events.at(-1)?.id || 0) + 1,
      type,
      payload,
      traceparent,
      createdAt,
    };
    events.push(event);
    return event;
  }
  appendOutbox(topic, payload, createdAt = this.timestamp()) {
    this.outbox.push({
      id: this.outbox.length + 1,
      topic,
      payload,
      createdAt,
      deliveredAt: null,
    });
  }
  notifyWork(message = { notified: true, expired: 0 }) {
    for (const wake of [...this.workWaiters]) wake(message);
  }
  createWorkWaiter(timeoutMs) {
    let timer;
    let settled = false;
    let resolveWait;
    const promise = new Promise((resolve) => {
      resolveWait = resolve;
    });
    const finish = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.workWaiters.delete(finish);
      resolveWait(message);
    };
    this.workWaiters.add(finish);
    timer = setTimeout(() => finish({ notified: false, expired: 0 }), Math.max(0, timeoutMs));
    return { promise, cancel: () => finish({ cancelled: true }) };
  }
  async createRun({
    projectId,
    revision,
    nodes = [],
    request,
    idempotencyKey,
    traceparent,
    repositoryDigest = null,
    worktreeDigest = null,
  }) {
    if (Buffer.byteLength(JSON.stringify({ revision, nodes, request })) > MAX_ENVELOPE_BYTES)
      throw Object.assign(new Error("run envelope exceeds 256 KiB"), { statusCode: 413 });
    if (digest(revision.definition) !== revision.digest)
      throw Object.assign(new Error("run revision digest mismatch"), { statusCode: 409 });
    return this.idempotent(`submit:${projectId}`, idempotencyKey, async () => {
      const run = {
        id: id(),
        projectId,
        state: RUN_STATE.QUEUED,
        request,
        revision,
        traceparent,
        repositoryDigest,
        worktreeDigest,
        pinnedWorkerId: null,
        createdAt: this.timestamp(),
        updatedAt: this.timestamp(),
      };
      this.runs.set(run.id, run);
      this.events.set(run.id, []);
      this.appendEvent(run.id, "run.queued", { runId: run.id }, traceparent);
      this.appendOutbox("run.queued", { runId: run.id, traceparent });
      for (const node of nodes)
        this.nodes.set(id(), {
          runId: run.id,
          key: node.key,
          payload: node.payload || {},
          access: node.access || "read",
          state: NODE_STATE.QUEUED,
          attempts: 0,
        });
      this.notifyWork();
      return { id: run.id, state: run.state };
    });
  }
  async getRun(runId) {
    return this.runs.get(runId) || null;
  }
  async listRunEvents(runId) {
    return this.events.get(runId) || [];
  }
  async listRunEventsAfter(runId, afterId = 0, limit = 100) {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 100)));
    const cursor =
      Number.isSafeInteger(Number(afterId)) && Number(afterId) >= 0 ? Number(afterId) : 0;
    return (this.events.get(runId) || [])
      .filter((event) => event.id > cursor)
      .slice(0, boundedLimit);
  }
  async metricsSnapshot() {
    const lastSeen = [...this.workers.values()]
      .map((worker) => Date.parse(worker.lastSeenAt))
      .filter(Number.isFinite);
    return {
      queueDepth: [...this.nodes.values()].filter((node) => node.state === NODE_STATE.QUEUED)
        .length,
      activeWaits: this.workWaiters.size,
      workerFreshnessSeconds: lastSeen.length
        ? Math.max(0, (Date.now() - Math.max(...lastSeen)) / 1000)
        : 0,
      outboxPending: this.outbox.filter((entry) => !entry.deliveredAt).length,
    };
  }
  async uploadRevision({ projectId, kind, document, expectedDigest, idempotencyKey }) {
    const actual = digest(document);
    if (actual !== expectedDigest)
      throw Object.assign(new Error("revision digest mismatch"), { statusCode: 409 });
    const valid = kind === "profile" || Array.isArray(document.nodes);
    if (!valid)
      throw Object.assign(new Error("workflow.nodes must be an array"), { statusCode: 400 });
    return this.idempotent(`revision:${projectId}:${kind}`, idempotencyKey, async () => {
      const record = {
        id: id(),
        projectId,
        kind,
        digest: actual,
        document,
        validation: { valid, errors: [] },
      };
      for (const revision of this.revisions.values())
        if (
          revision.projectId === projectId &&
          revision.kind === kind &&
          revision.digest === actual
        )
          return revision;
      this.revisions.set(record.id, record);
      return record;
    });
  }
  async getRevision(revisionId) {
    return this.revisions.get(revisionId) || null;
  }
  async diffRevisions({ fromId, toId }) {
    const from = await this.getRevision(fromId);
    const to = await this.getRevision(toId);
    if (!from || !to || from.projectId !== to.projectId || from.kind !== to.kind)
      throw Object.assign(new Error("comparable revisions not found"), { statusCode: 404 });
    return {
      from: from.digest,
      to: to.digest,
      changed: canonical(from.document) !== canonical(to.document),
    };
  }
  async activateRevision({ projectId, kind, revisionId, expectedDigest, idempotencyKey }) {
    return this.idempotent(`activate:${projectId}:${kind}`, idempotencyKey, async () => {
      const revision = await this.getRevision(revisionId);
      if (
        !revision ||
        revision.projectId !== projectId ||
        revision.kind !== kind ||
        revision.digest !== expectedDigest
      )
        throw Object.assign(new Error("exact revision digest confirmation required"), {
          statusCode: 409,
        });
      this.active.set(`${projectId}:${kind}`, revision);
      return { revisionId, digest: expectedDigest };
    });
  }
  async registerWorker({
    workerId,
    repositoryDigest,
    worktreeDigest,
    capabilities = {},
    projects = [],
    idempotencyKey,
  }) {
    return this.idempotent(`register:${workerId}`, idempotencyKey, async () => {
      const worker = {
        workerId,
        repositoryDigest,
        worktreeDigest,
        capabilities,
        projects,
        lastSeenAt: new Date().toISOString(),
      };
      this.workers.set(workerId, worker);
      return worker;
    });
  }
  reclaimExpired() {
    let reclaimed = 0;
    for (const [nodeId, lease] of this.leases) {
      if (lease.expiresAt > this.now()) continue;
      this.leases.delete(nodeId);
      const node = this.nodes.get(nodeId);
      const run = node && this.runs.get(node.runId);
      if (node?.state === NODE_STATE.LEASED && run && !TERMINAL_RUN_STATES.includes(run.state)) {
        node.state = NODE_STATE.QUEUED;
        reclaimed += 1;
      }
    }
    if (reclaimed) this.notifyWork({ notified: true, expired: reclaimed });
    return reclaimed;
  }
  claimOnce({ workerId, projects }) {
    if (this.closed) throw storeClosedError();
    const worker = this.workers.get(workerId);
    if (!worker)
      throw Object.assign(new Error("worker must register before claiming"), { statusCode: 409 });
    this.reclaimExpired();
    const wildcard = projects.includes("*");
    const permitted = wildcard
      ? worker.projects
      : projects.filter((project) => worker.projects.includes(project));
    for (const [nodeId, node] of this.nodes) {
      if (node.state !== NODE_STATE.QUEUED) continue;
      const run = this.runs.get(node.runId);
      if (!run || ![RUN_STATE.QUEUED, RUN_STATE.RUNNING].includes(run.state)) continue;
      if (!wildcard && !permitted.includes(run.projectId)) continue;
      const active = [...this.leases.values()].filter((lease) => lease.runId === run.id);
      const hasWriter = active.some((lease) => this.nodes.get(lease.nodeId).access === "write");
      if (
        (run.pinnedWorkerId && run.pinnedWorkerId !== workerId) ||
        (run.repositoryDigest && run.repositoryDigest !== worker.repositoryDigest) ||
        (run.worktreeDigest && run.worktreeDigest !== worker.worktreeDigest) ||
        (node.access === "write" && active.length) ||
        (node.access !== "write" &&
          (hasWriter ||
            active.filter((lease) => this.nodes.get(lease.nodeId).access !== "write").length >= 4))
      )
        continue;
      node.state = NODE_STATE.LEASED;
      const fence = ++node.attempts;
      run.pinnedWorkerId ||= workerId;
      run.state = RUN_STATE.RUNNING;
      run.updatedAt = this.timestamp();
      const claim = {
        attemptId: id(),
        nodeId,
        runId: node.runId,
        projectId: run.projectId,
        nodeKey: node.key,
        access: node.access,
        payload: node.payload,
        fence,
        leaseSeconds: 60,
        heartbeatSeconds: 20,
        workerId,
        expiresAt: this.now() + 60000,
      };
      this.leases.set(nodeId, claim);
      return claim;
    }
    return null;
  }
  async claim({ workerId, longPollSeconds = 0, projects = [], idempotencyKey }) {
    if (this.closed) throw storeClosedError();
    return this.idempotent(`claim:${workerId}`, idempotencyKey, async () => {
      const waitSeconds = Math.min(MAX_LONG_POLL_SECONDS, Math.max(0, longPollSeconds || 0));
      const deadline = this.now() + waitSeconds * 1000;
      while (true) {
        const remainingMs = Math.max(0, deadline - this.now());
        const waiter = remainingMs > 0 ? this.createWorkWaiter(remainingMs) : null;
        if (this.closed) {
          waiter?.cancel();
          throw storeClosedError();
        }
        const claim = this.claimOnce({ workerId, projects });
        if (claim) {
          waiter?.cancel();
          return claim;
        }
        if (!waiter) return null;
        const wake = await waiter.promise;
        if (wake.cancelled || this.closed) throw storeClosedError();
      }
    });
  }
  async heartbeat({ workerId, nodeId, fence }) {
    const lease = this.leases.get(nodeId);
    const worker = this.workers.get(workerId);
    const node = this.nodes.get(nodeId);
    const projectId = node ? this.runs.get(node.runId)?.projectId : null;
    if (
      !lease ||
      !worker ||
      (!worker.projects.includes("*") && !worker.projects.includes(projectId)) ||
      lease.workerId !== workerId ||
      lease.fence !== fence ||
      lease.expiresAt <= this.now()
    )
      throw Object.assign(new Error("lease missing, expired, or fenced"), { statusCode: 409 });
    lease.expiresAt = this.now() + 60000;
    return { expiresAt: new Date(lease.expiresAt).toISOString() };
  }
  async report({ workerId, nodeId, fence, outcome, result = {}, idempotencyKey }) {
    return this.idempotent(`report:${nodeId}`, idempotencyKey, async () => {
      const node = this.nodes.get(nodeId);
      if (!node)
        throw Object.assign(new Error("lease missing, expired, or fenced"), { statusCode: 409 });
      return this.withRunLock(node.runId, async () => {
        const run = this.runs.get(node.runId);
        if (!run || ![RUN_STATE.QUEUED, RUN_STATE.RUNNING].includes(run.state))
          throw Object.assign(new Error("run is no longer active"), { statusCode: 409 });
        await this.heartbeat({ workerId, nodeId, fence });
        const state = outcome === RUN_STATE.SUCCEEDED ? NODE_STATE.SUCCEEDED : NODE_STATE.FAILED;
        node.state = state;
        this.leases.delete(nodeId);
        const eventPayload = { runId: run.id, nodeId, fence, result };
        const completedAt = this.timestamp();
        this.appendEvent(run.id, `node.${state}`, eventPayload, null, completedAt);
        this.appendOutbox(`node.${state}`, eventPayload, completedAt);
        const runNodes = [...this.nodes.values()].filter((candidate) => candidate.runId === run.id);
        const allTerminal = runNodes.every((candidate) =>
          TERMINAL_NODE_STATES.includes(candidate.state),
        );
        if (allTerminal) {
          run.state = runNodes.some((candidate) => candidate.state === NODE_STATE.FAILED)
            ? RUN_STATE.FAILED
            : RUN_STATE.SUCCEEDED;
          run.updatedAt = completedAt;
          const terminalPayload = {
            runId: run.id,
            state: run.state,
            completedAt: run.updatedAt,
          };
          this.appendEvent(run.id, `run.${run.state}`, terminalPayload, null, completedAt);
          this.appendOutbox(`run.${run.state}`, terminalPayload, completedAt);
        } else {
          run.state = RUN_STATE.RUNNING;
          run.updatedAt = this.timestamp();
        }
        this.notifyWork();
        return { state, runState: run.state };
      });
    });
  }
  async signalRun({ runId, kind, payload, idempotencyKey }) {
    return this.idempotent(`signal:${runId}`, idempotencyKey, async () => {
      return this.appendEvent(runId, `signal.${kind}`, payload);
    });
  }
  async cancelRun({ runId, idempotencyKey }) {
    return this.idempotent(`cancel:${runId}`, idempotencyKey, async () => {
      return this.withRunLock(runId, async () => {
        const run = this.runs.get(runId);
        if (!run) throw Object.assign(new Error("run not found"), { statusCode: 404 });
        if (![RUN_STATE.QUEUED, RUN_STATE.RUNNING].includes(run.state))
          throw Object.assign(new Error("run cannot be cancelled"), { statusCode: 409 });
        run.state = RUN_STATE.CANCELLED;
        run.cancelledAt = this.timestamp();
        run.updatedAt = run.cancelledAt;
        for (const [nodeId, node] of this.nodes) {
          if (node.runId !== runId || ![NODE_STATE.QUEUED, NODE_STATE.LEASED].includes(node.state))
            continue;
          node.state = NODE_STATE.CANCELLED;
          this.leases.delete(nodeId);
        }
        const payload = { runId, state: run.state, completedAt: run.cancelledAt };
        this.appendEvent(runId, "run.cancelled", payload, null, run.cancelledAt);
        this.appendOutbox("run.cancelled", payload, run.cancelledAt);
        this.notifyWork();
        return { id: runId, state: run.state, cancelledAt: run.cancelledAt };
      });
    });
  }
  async rebindRun({ runId, workerId, repositoryDigest, worktreeDigest, idempotencyKey }) {
    return this.idempotent(`rebind:${runId}`, idempotencyKey, async () => {
      const run = this.runs.get(runId);
      const worker = this.workers.get(workerId);
      if (
        !run ||
        !worker ||
        run.repositoryDigest !== repositoryDigest ||
        run.worktreeDigest !== worktreeDigest ||
        worker.repositoryDigest !== repositoryDigest ||
        worker.worktreeDigest !== worktreeDigest
      )
        throw Object.assign(new Error("matching repository and worktree digests are required"), {
          statusCode: 409,
        });
      run.pinnedWorkerId = workerId;
      return { runId, workerId };
    });
  }
  async reserveArtifact({ workerId, nodeId, fence, objectKey, expectedSha256, expectedSizeBytes }) {
    await this.heartbeat({ workerId, nodeId, fence });
    const artifact = {
      id: id(),
      runId: this.nodes.get(nodeId).runId,
      nodeId,
      workerId,
      fence,
      objectKey,
      expectedSha256,
      expectedSizeBytes,
      state: "reserved",
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }
  async getArtifact(artifactId) {
    return this.artifacts.get(artifactId) || null;
  }
  async verifyArtifact({
    id: artifactId,
    sha256,
    sizeBytes,
    workerId,
    nodeId,
    fence,
    objectVersionId,
  }) {
    const artifact = this.artifacts.get(artifactId);
    await this.heartbeat({ workerId, nodeId, fence });
    if (
      artifact?.state !== "reserved" ||
      artifact.workerId !== workerId ||
      artifact.nodeId !== nodeId ||
      artifact.fence !== fence
    )
      throw Object.assign(
        new Error("artifact reservation is not owned by an active fenced attempt"),
        { statusCode: 409 },
      );
    Object.assign(artifact, { state: "verified", sha256, sizeBytes, objectVersionId });
    return artifact;
  }
  async quarantineArtifact({ id: artifactId, quarantineKey }) {
    const artifact = this.artifacts.get(artifactId);
    if (artifact) Object.assign(artifact, { state: "rejected", quarantineKey });
  }
}
