/** Purpose: reserve, presign, and verify S3-compatible immutable artifacts. */
import crypto from "node:crypto";
import { CopyObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand } from "@aws-sdk/client-s3";

export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

export function createArtifactService({ store, storage, s3 = null }) {
  const client =
    s3 ||
    new S3Client({
      region: storage.region,
      endpoint: storage.endpoint,
      forcePathStyle: storage.forcePathStyle,
    });
  return {
    async reserve({
      workerId,
      nodeId,
      fence,
      sha256,
      sizeBytes,
      contentType = "application/octet-stream",
    }) {
      if (
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 0 ||
        sizeBytes > MAX_ARTIFACT_BYTES
      )
        throw Object.assign(new Error("invalid artifact digest or size"), { statusCode: 400 });
      const objectKey = `sha256/${sha256}`;
      const artifact = await store.reserveArtifact({
        workerId,
        nodeId,
        fence,
        objectKey,
        expectedSha256: sha256,
        expectedSizeBytes: sizeBytes,
      });
      const checksum = Buffer.from(sha256, "hex").toString("base64");
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: storage.bucket,
          Key: objectKey,
          ContentType: contentType,
          ContentLength: sizeBytes,
          ChecksumSHA256: checksum,
        }),
        { expiresIn: 300 },
      );
      return { ...artifact, objectKey, uploadUrl, expiresInSeconds: 300 };
    },
    async verify({ id, sha256, sizeBytes, workerId, nodeId, fence }) {
      if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
        throw Object.assign(new Error("invalid artifact digest or size"), { statusCode: 400 });
      const artifact = await store.getArtifact(id);
      if (artifact?.state !== "reserved")
        throw Object.assign(new Error("artifact reservation missing"), { statusCode: 409 });
      if (artifact.expectedSha256 !== sha256 || Number(artifact.expectedSizeBytes) !== sizeBytes)
        throw Object.assign(new Error("artifact verification must match its reservation"), {
          statusCode: 409,
        });
      const object = await client.send(
        new GetObjectCommand({ Bucket: storage.bucket, Key: artifact.objectKey }),
      );
      const hash = crypto.createHash("sha256");
      let actualSize = 0;
      for await (const chunk of object.Body) {
        actualSize += chunk.length;
        hash.update(chunk);
      }
      const actual = hash.digest("hex");
      if (actualSize !== sizeBytes || actual !== sha256 || !object.VersionId) {
        const quarantineKey = `quarantine/${artifact.id}/${artifact.objectKey}`;
        await client.send(
          new CopyObjectCommand({
            Bucket: storage.bucket,
            Key: quarantineKey,
            CopySource: `${storage.bucket}/${artifact.objectKey}`,
          }),
        );
        if (store.quarantineArtifact) await store.quarantineArtifact({ id, quarantineKey });
        throw Object.assign(
          new Error(
            "uploaded artifact checksum, size, or immutable version is invalid and was quarantined",
          ),
          { statusCode: 409 },
        );
      }
      return store.verifyArtifact({
        id,
        sha256,
        sizeBytes,
        workerId,
        nodeId,
        fence,
        objectVersionId: object.VersionId,
      });
    },
    async download({ artifact }) {
      if (artifact.state !== "verified")
        throw Object.assign(new Error("artifact is not verified"), { statusCode: 409 });
      return {
        downloadUrl: await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: storage.bucket,
            Key: artifact.objectKey,
            VersionId: artifact.objectVersionId || undefined,
          }),
          { expiresIn: 300 },
        ),
        expiresInSeconds: 300,
      };
    },
  };
}
