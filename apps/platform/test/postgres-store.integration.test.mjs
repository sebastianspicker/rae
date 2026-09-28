/** Purpose: opt-in disposable-schema PostgreSQL integration tests for hosted concurrency. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { digest, PostgresStore, RUN_STATE } from "../src/store.mjs";

const DATABASE_URL = process.env.RAE_PLATFORM_DATABASE_URL;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = "integration-worker";
const PROJECT = "integration-project";

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for integration precondition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("PostgreSQL store concurrency and notification lifecycle", {
  skip: DATABASE_URL ? false : "RAE_PLATFORM_DATABASE_URL is not configured",
}, async (t) => {
  const { Pool } = pg;
  const admin = new Pool({ connectionString: DATABASE_URL });
  const schema = `rae_platform_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  const store = new PostgresStore(pool);
  t.after(async () => {
    await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  for (const migration of (await fs.readdir(path.join(ROOT, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await store.migrate(
      migration,
      await fs.readFile(path.join(ROOT, "migrations", migration), "utf8"),
    );
  }
  await store.registerWorker({
    workerId: WORKER,
    repositoryDigest: "a".repeat(64),
    worktreeDigest: "b".repeat(64),
    projects: [PROJECT],
    idempotencyKey: "register",
  });

  let sequence = 0;
  async function createRun(nodes) {
    sequence += 1;
    const definition = { nodes };
    return store.createRun({
      projectId: PROJECT,
      revision: { definition, digest: digest(definition) },
      nodes,
      request: {},
      idempotencyKey: `run-${sequence}`,
    });
  }
  async function claim(key, longPollSeconds = 0) {
    return store.claim({
      workerId: WORKER,
      projects: [PROJECT],
      longPollSeconds,
      idempotencyKey: key,
    });
  }

  await t.test("concurrent mixed reports aggregate once in the report transaction", async () => {
    const run = await createRun([{ key: "mixed-one" }, { key: "mixed-two" }]);
    const first = await claim("mixed-claim-1");
    const second = await claim("mixed-claim-2");
    await Promise.all([
      store.report({
        workerId: WORKER,
        nodeId: first.nodeId,
        fence: first.fence,
        outcome: "failed",
        idempotencyKey: "mixed-report-1",
      }),
      store.report({
        workerId: WORKER,
        nodeId: second.nodeId,
        fence: second.fence,
        outcome: "succeeded",
        idempotencyKey: "mixed-report-2",
      }),
    ]);
    assert.equal((await store.getRun(run.id)).state, RUN_STATE.FAILED);
    const terminal = await pool.query(
      "SELECT (SELECT count(*) FROM events WHERE run_id=$1 AND type='run.failed')::int AS events, (SELECT count(*) FROM outbox WHERE topic='run.failed' AND payload->>'runId'=$1)::int AS outbox",
      [run.id],
    );
    assert.deepEqual(terminal.rows[0], { events: 1, outbox: 1 });
  });

  await t.test("duplicate report and stale fence cannot duplicate completion", async () => {
    const run = await createRun([{ key: "duplicate" }]);
    const leased = await claim("duplicate-claim");
    const input = {
      workerId: WORKER,
      nodeId: leased.nodeId,
      fence: leased.fence,
      outcome: "succeeded",
      idempotencyKey: "duplicate-report",
    };
    const [first, second] = await Promise.all([store.report(input), store.report(input)]);
    assert.deepEqual(first, second);
    await assert.rejects(
      store.report({ ...input, fence: leased.fence + 1, idempotencyKey: "wrong-fence" }),
      /active|expired|fenced/,
    );
    const counts = await pool.query(
      "SELECT (SELECT count(*) FROM events WHERE run_id=$1 AND type='node.succeeded')::int AS nodes, (SELECT count(*) FROM events WHERE run_id=$1 AND type='run.succeeded')::int AS runs",
      [run.id],
    );
    assert.deepEqual(counts.rows[0], { nodes: 1, runs: 1 });
  });

  await t.test("cancel and report serialize on the run row", async () => {
    const run = await createRun([{ key: "cancel-race" }]);
    const leased = await claim("cancel-claim");
    const results = await Promise.allSettled([
      store.cancelRun({ runId: run.id, idempotencyKey: "cancel-race" }),
      store.report({
        workerId: WORKER,
        nodeId: leased.nodeId,
        fence: leased.fence,
        outcome: "succeeded",
        idempotencyKey: "cancel-report",
      }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const final = await store.getRun(run.id);
    const terminal = await pool.query(
      "SELECT count(*)::int AS count FROM events WHERE run_id=$1 AND type IN ('run.succeeded','run.failed','run.cancelled')",
      [run.id],
    );
    assert.ok([RUN_STATE.SUCCEEDED, RUN_STATE.CANCELLED].includes(final.state));
    assert.equal(terminal.rows[0].count, 1);
  });

  await t.test("report rechecks lease expiry after waiting on its lease row", async () => {
    const run = await createRun([{ key: "delayed-report" }]);
    const leased = await claim("delayed-report-claim");
    await pool.query(
      "UPDATE leases SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE node_id=$1",
      [leased.nodeId],
    );
    const blocker = await pool.connect();
    let reporting;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT node_id FROM leases WHERE node_id=$1 FOR UPDATE", [
        leased.nodeId,
      ]);
      reporting = store.report({
        workerId: WORKER,
        nodeId: leased.nodeId,
        fence: leased.fence,
        outcome: "succeeded",
        idempotencyKey: "delayed-report",
      });
      await waitUntil(async () => {
        const waiting = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT l.node_id FROM leases%' AND wait_event_type='Lock'",
        );
        return waiting.rowCount > 0;
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    await assert.rejects(reporting, /expired|fenced/);
    assert.equal((await store.getRun(run.id)).state, RUN_STATE.RUNNING);
    await store.cancelRun({ runId: run.id, idempotencyKey: "cancel-delayed-report" });
  });

  await t.test("heartbeat rechecks lease expiry after waiting on its lease row", async () => {
    const run = await createRun([{ key: "delayed-heartbeat" }]);
    const leased = await claim("delayed-heartbeat-claim");
    await pool.query(
      "UPDATE leases SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE node_id=$1",
      [leased.nodeId],
    );
    const blocker = await pool.connect();
    let heartbeat;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT node_id FROM leases WHERE node_id=$1 FOR UPDATE", [
        leased.nodeId,
      ]);
      heartbeat = store.heartbeat({
        workerId: WORKER,
        nodeId: leased.nodeId,
        fence: leased.fence,
      });
      await waitUntil(async () => {
        const waiting = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT l.node_id FROM leases%' AND wait_event_type='Lock'",
        );
        return waiting.rowCount > 0;
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    await assert.rejects(heartbeat, /expired|fenced/);
    await store.cancelRun({ runId: run.id, idempotencyKey: "cancel-delayed-heartbeat" });
  });

  await t.test("a locked expired lease cannot stall an unrelated claim probe", async () => {
    await createRun([{ key: "locked-expired" }]);
    const expired = await claim("locked-expired-claim");
    await pool.query(
      "UPDATE leases SET expires_at=clock_timestamp()-interval '1 second' WHERE node_id=$1",
      [expired.nodeId],
    );
    const blocker = await pool.connect();
    let unrelatedRun;
    let unrelatedClaim;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT node_id FROM leases WHERE node_id=$1 FOR UPDATE", [
        expired.nodeId,
      ]);
      unrelatedRun = await createRun([{ key: "unrelated" }]);
      unrelatedClaim = await Promise.race([
        claim("unrelated-claim"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("unrelated claim stalled on expired lease")), 500),
        ),
      ]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    assert.equal(unrelatedClaim.runId, unrelatedRun.id);
    await store.cancelRun({ runId: expired.runId, idempotencyKey: "cancel-locked-expired" });
    await store.cancelRun({ runId: unrelatedRun.id, idempotencyKey: "cancel-unrelated" });
  });

  await t.test("reader claims cap at four and a writer remains exclusive", async () => {
    const readerRun = await createRun(
      Array.from({ length: 5 }, (_, index) => ({ key: `reader-${index}`, access: "read" })),
    );
    const readers = [];
    for (let index = 0; index < 4; index += 1) readers.push(await claim(`reader-claim-${index}`));
    assert.ok(readers.every((reader) => reader.runId === readerRun.id));
    assert.equal(await claim("reader-cap"), null);

    const writerRun = await createRun([
      { key: "writer", access: "write" },
      { key: "blocked-reader", access: "read" },
    ]);
    const ordered = await pool.query("SELECT id FROM run_nodes WHERE run_id=$1 ORDER BY id", [
      writerRun.id,
    ]);
    await pool.query(
      "UPDATE run_nodes SET access=CASE WHEN id=$2 THEN 'write' ELSE 'read' END WHERE run_id=$1",
      [writerRun.id, ordered.rows[0].id],
    );
    const writer = await claim("writer-claim");
    assert.equal(writer.runId, writerRun.id);
    assert.equal(writer.access, "write");
    assert.equal(await claim("writer-exclusive"), null);
    await store.cancelRun({ runId: readerRun.id, idempotencyKey: "cancel-readers" });
    await store.cancelRun({ runId: writerRun.id, idempotencyKey: "cancel-writer" });
  });

  await t.test("reconciliation wakes a registered long poll and increments its fence", async () => {
    await createRun([{ key: "reclaim" }]);
    const stale = await claim("reclaim-first");
    const waiting = claim("reclaim-second", 1);
    await waitUntil(() => store.workWaiters.size === 1);
    await pool.query("UPDATE leases SET expires_at=now()-interval '1 second' WHERE node_id=$1", [
      stale.nodeId,
    ]);
    assert.equal(await store.reconcile(), 1);
    const current = await waiting;
    assert.equal(current.nodeId, stale.nodeId);
    assert.equal(current.fence, stale.fence + 1);
    assert.equal(store.workWaiters.size, 0);
  });

  await t.test(
    "creation notification closes the probe race without holding worker locks",
    async () => {
      const waiting = claim("creation-wait", 1);
      await waitUntil(() => store.workWaiters.size === 1);
      await store.registerWorker({
        workerId: WORKER,
        repositoryDigest: "a".repeat(64),
        worktreeDigest: "b".repeat(64),
        projects: [PROJECT],
        idempotencyKey: "register-while-waiting",
      });
      await createRun([{ key: "created-late" }]);
      assert.equal((await waiting).nodeKey, "created-late");
      assert.equal(store.workWaiters.size, 0);
    },
  );

  await t.test("empty claim idempotency is persisted only after timeout", async () => {
    const waiting = claim("empty-timeout", 0.1);
    await waitUntil(() => store.workWaiters.size === 1);
    const before = await pool.query("SELECT 1 FROM idempotency_keys WHERE key=$1", [
      `claim:${WORKER}:empty-timeout`,
    ]);
    assert.equal(before.rowCount, 0);
    assert.equal(await waiting, null);
    const after = await pool.query("SELECT response FROM idempotency_keys WHERE key=$1", [
      `claim:${WORKER}:empty-timeout`,
    ]);
    assert.equal(after.rowCount, 1);
    assert.equal(after.rows[0].response, null);
    assert.equal(store.workWaiters.size, 0);
  });
});
