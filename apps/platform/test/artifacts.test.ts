/** Artifact verification claims precede storage access and fence every final state change. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  createArtifactService,
  type ArtifactRecord,
  type ArtifactStorage,
  type ArtifactStore,
  type VerificationRequest,
} from "../src/artifacts.js";
const bytes = Buffer.from("artifact bytes");
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const request: VerificationRequest = {
  id: "artifact",
  workerId: "worker",
  nodeId: "node",
  fence: 1,
  sha256,
  sizeBytes: bytes.length,
};
function fixture() {
  let active = true;
  let claim: string | null = null;
  const artifact: ArtifactRecord = {
    id: request.id,
    runId: "run",
    objectKey: "legacy/key",
    state: "reserved",
    expectedSha256: sha256,
    expectedSizeBytes: bytes.length,
  };
  const calls: string[] = [];
  const authorized = (value: VerificationRequest) => {
    if (
      !active ||
      value.id !== artifact.id ||
      value.workerId !== request.workerId ||
      value.nodeId !== request.nodeId ||
      value.fence !== request.fence ||
      value.sha256 !== sha256 ||
      value.sizeBytes !== bytes.length
    )
      throw Object.assign(new Error("inactive or foreign reservation"), { statusCode: 409 });
  };
  const store: ArtifactStore = {
    async abandonArtifactReservation() {
      artifact.state = "rejected";
    },
    async reserveArtifact(value) {
      return { ...artifact, id: value.artifactId, objectKey: value.objectKey };
    },
    async claimArtifactVerification(value) {
      authorized(value);
      if (claim || artifact.state !== "reserved") throw new Error("already claimed");
      claim = value.claimId;
      return { ...artifact, claimId: claim };
    },
    async verifyArtifact(value) {
      authorized(value);
      assert.equal(claim, value.claimId);
      artifact.state = "verified";
      artifact.objectVersionId = value.objectVersionId;
      return artifact;
    },
    async rejectArtifactVerification(value) {
      authorized(value);
      assert.equal(claim, value.claimId);
      artifact.state = "rejected";
    },
    async releaseArtifactVerification(value) {
      if (claim === value.claimId) claim = null;
    },
  };
  const objects: ArtifactStorage = {
    async uploadUrl(key) {
      calls.push(`put:${key}`);
      return "https://storage.invalid/upload";
    },
    async read(key) {
      calls.push(`get:${key}`);
      return { body: Readable.from([bytes]), versionId: "version" };
    },
    async quarantine(_key, version) {
      calls.push(`quarantine:${version}`);
    },
    async downloadUrl(key, version) {
      calls.push(`download:${key}:${version}`);
      return "https://storage.invalid/download";
    },
  };
  return {
    store,
    objects,
    calls,
    artifact,
    expire: () => {
      active = false;
    },
    service: (timeout?: number) =>
      createArtifactService({
        store,
        objects,
        storage: { bucket: "bucket", region: "test" },
        verificationTimeoutMs: timeout,
      }),
  };
}
test("expired, foreign and mismatched verification requests make zero storage calls", async () => {
  for (const changes of [
    { workerId: "foreign" },
    { nodeId: "foreign" },
    { fence: 2 },
    { sha256: "0".repeat(64) },
    { sizeBytes: 0 },
    {},
  ]) {
    const f = fixture();
    if (!Object.keys(changes).length) f.expire();
    await assert.rejects(f.service().verify({ ...request, ...changes }));
    assert.deepEqual(f.calls, []);
  }
});
test("concurrent verification has one claim and finalization revalidates the fence", async () => {
  const f = fixture();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.objects.read = async () => {
    f.calls.push("get");
    await paused;
    return { body: Readable.from([bytes]), versionId: "v1" };
  };
  const first = f.service().verify(request);
  await assert.rejects(f.service().verify(request), /already claimed/);
  f.expire();
  release();
  await assert.rejects(first, /inactive or foreign/);
  assert.deepEqual(f.calls, ["get"]);
  assert.equal(f.artifact.state, "reserved");
});
test("stream overflow aborts immediately and never copies the oversized object", async () => {
  const f = fixture();
  let destroyed = false;
  let aborted = false;
  const body = new Readable({
    read() {
      this.push(Buffer.alloc(bytes.length + 1));
    },
    destroy(error, done) {
      destroyed = true;
      done(error);
    },
  });
  f.objects.read = async (_key, signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return { body, versionId: "v1" };
  };
  await assert.rejects(f.service().verify(request), /exceeds its reserved size/);
  assert.ok(destroyed);
  assert.ok(aborted);
  assert.equal(f.artifact.state, "rejected");
  assert.deepEqual(f.calls, []);
});
test("content-length overflow rejects without consuming the body", async () => {
  const f = fixture();
  let reads = 0;
  const body = new Readable({
    read() {
      reads++;
      this.push(null);
    },
  });
  f.objects.read = async () => ({ body, contentLength: bytes.length + 1, versionId: "v1" });
  await assert.rejects(f.service().verify(request), /exceeds its reserved size/);
  assert.equal(reads, 0);
  assert.ok(body.destroyed);
});
test("verification deadline destroys stalled streams and releases the claim", async () => {
  const f = fixture();
  const body = new Readable({ read() {} });
  f.objects.read = async () => ({ body, versionId: "v1" });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(f.service(10).verify(request));
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(body.destroyed);
  assert.equal(f.artifact.state, "reserved");
  f.objects.read = async () => ({ body: Readable.from([bytes]), versionId: "v2" });
  assert.equal((await f.service().verify(request)).objectVersionId, "v2");
});
test("new reservations have isolated keys and old reservations retain versioned reads", async () => {
  const f = fixture();
  const first = await f.service().reserve(request);
  const second = await f.service().reserve(request);
  assert.notEqual(first.objectKey, second.objectKey);
  assert.equal(first.objectKey, `reservations/${first.id}/${sha256}`);
  await f.service().verify(request);
  await f.service().download({ artifact: f.artifact });
  assert.ok(f.calls.includes("get:legacy/key"));
  assert.ok(f.calls.includes("download:legacy/key:version"));
});
test("mismatch quarantine pins the exact read version", async () => {
  const f = fixture();
  f.objects.read = async () => ({
    body: Readable.from([Buffer.alloc(bytes.length)]),
    versionId: "read-version",
  });
  await assert.rejects(f.service().verify(request), /checksum/);
  assert.deepEqual(f.calls, ["quarantine:read-version"]);
  assert.equal(f.artifact.state, "rejected");
});

test("terminal writes are not masked by release failures, and primary errors survive cleanup", async () => {
  const success = fixture();
  success.store.releaseArtifactVerification = async () => {
    throw new Error("cleanup unavailable");
  };
  assert.equal((await success.service().verify(request)).state, "verified");
  const failure = fixture();
  failure.objects.read = async () => {
    throw new Error("storage unavailable");
  };
  failure.store.releaseArtifactVerification = async () => {
    throw new Error("cleanup unavailable");
  };
  await assert.rejects(failure.service().verify(request), {
    message: "storage unavailable",
    cleanupFailed: true,
  });
});
test("a presign failure abandons the unclaimed reservation", async () => {
  const f = fixture();
  f.objects.uploadUrl = async () => {
    throw new Error("signing unavailable");
  };
  await assert.rejects(f.service().reserve(request), /signing unavailable/);
  assert.equal(f.artifact.state, "rejected");
});
