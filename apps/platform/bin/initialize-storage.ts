#!/usr/bin/env node
/** Purpose: prepare only the disposable development artifact bucket with versioning enabled. */
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { setTimeout as sleep } from "node:timers/promises";
const accessKeyId = process.env.MINIO_ROOT_USER;
const secretAccessKey = process.env.MINIO_ROOT_PASSWORD;
if (!accessKeyId || !secretAccessKey) throw new Error("Disposable MinIO credentials are required");
const bucket = "rae-artifacts";
const client = new S3Client({
  endpoint: "http://minio:9000",
  region: "us-east-1",
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: { accessKeyId, secretAccessKey },
});
function status(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== "object" || !("httpStatusCode" in metadata))
    return undefined;
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}
try {
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), {
        abortSignal: AbortSignal.timeout(5000),
      });
      ready = true;
      break;
    } catch (error) {
      if (status(error) === 404) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }), {
            abortSignal: AbortSignal.timeout(5000),
          });
        } catch (creation) {
          if (!(creation instanceof Error && creation.name === "BucketAlreadyOwnedByYou"))
            throw new Error("Development artifact bucket creation failed");
        }
        ready = true;
        break;
      }
      if (status(error) === 401 || status(error) === 403)
        throw new Error("Development object storage rejected its configured credentials");
      await sleep(1000);
    }
  }
  if (!ready) throw new Error("Development object storage did not become ready within 60 seconds");
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
    { abortSignal: AbortSignal.timeout(5000) },
  );
  console.log("Disposable development artifact bucket is ready with object versioning enabled");
} finally {
  client.destroy();
}
