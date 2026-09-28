/** Fenced artifact reservations authorize and claim verification before object storage access. */
import crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
export interface ArtifactOwner {
  projects?: readonly string[];
  workerId: string;
  nodeId: string;
  fence: number | string;
}
export interface ArtifactRecord {
  id: string;
  runId: string;
  objectKey: string;
  state: string;
  objectVersionId?: string | null;
  expectedSha256?: string;
  expectedSizeBytes?: number | string;
}
export interface VerificationRequest extends ArtifactOwner {
  id: string;
  sha256: string;
  sizeBytes: number;
}
export interface VerificationClaim extends ArtifactRecord {
  claimId: string;
}
/** Each claim/finalization is atomic and checks the live lease, attempt, worker, and reservation. */
export interface ArtifactStore {
  reserveArtifact(
    request: ArtifactOwner & {
      artifactId: string;
      objectKey: string;
      expectedSha256: string;
      expectedSizeBytes: number;
    },
  ): Promise<ArtifactRecord>;
  abandonArtifactReservation(request: ArtifactOwner & { id: string }): Promise<void>;
  claimArtifactVerification(
    request: VerificationRequest & { claimId: string; claimSeconds: number },
  ): Promise<VerificationClaim>;
  verifyArtifact(
    request: VerificationRequest & { claimId: string; objectVersionId: string },
  ): Promise<ArtifactRecord>;
  rejectArtifactVerification(
    request: VerificationRequest & { claimId: string; quarantineKey: string | null },
  ): Promise<void>;
  releaseArtifactVerification(request: VerificationRequest & { claimId: string }): Promise<void>;
}
export interface ArtifactStorage {
  uploadUrl(key: string, size: number, type: string, checksum: string): Promise<string>;
  read(
    key: string,
    signal: AbortSignal,
  ): Promise<{ body: Readable; versionId?: string; contentLength?: number }>;
  quarantine(key: string, versionId: string, target: string, signal: AbortSignal): Promise<void>;
  downloadUrl(key: string, versionId: string): Promise<string>;
}
export interface StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}
export function s3ArtifactStorage(
  storage: StorageConfig,
  client = new S3Client(storage),
): ArtifactStorage {
  return {
    uploadUrl: (Key, ContentLength, ContentType, ChecksumSHA256) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: storage.bucket,
          Key,
          ContentLength,
          ContentType,
          ChecksumSHA256,
        }),
        { expiresIn: 300 },
      ),
    async read(Key, signal) {
      const object = await client.send(new GetObjectCommand({ Bucket: storage.bucket, Key }), {
        abortSignal: signal,
      });
      if (!(object.Body instanceof Readable))
        throw new Error("Object storage did not return a Node byte stream");
      return {
        body: object.Body,
        versionId: object.VersionId,
        contentLength: object.ContentLength,
      };
    },
    async quarantine(key, versionId, Key, signal) {
      const source = `${encodeURIComponent(storage.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(versionId)}`;
      await client.send(
        new CopyObjectCommand({ Bucket: storage.bucket, Key, CopySource: source }),
        { abortSignal: signal },
      );
    },
    downloadUrl: (Key, VersionId) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: storage.bucket, Key, VersionId }), {
        expiresIn: 300,
      }),
  };
}
function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}
function validate(sha256: string, sizeBytes: number): void {
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > MAX_ARTIFACT_BYTES
  )
    throw Object.assign(new Error("invalid artifact digest or size"), { statusCode: 400 });
}
export function createArtifactService({
  store,
  storage,
  objects = s3ArtifactStorage(storage),
  verificationTimeoutMs = VERIFICATION_TIMEOUT_MS,
}: {
  store: ArtifactStore;
  storage: StorageConfig;
  objects?: ArtifactStorage;
  verificationTimeoutMs?: number;
}) {
  if (
    !Number.isSafeInteger(verificationTimeoutMs) ||
    verificationTimeoutMs <= 0 ||
    verificationTimeoutMs > VERIFICATION_TIMEOUT_MS
  )
    throw new Error("Invalid artifact verification deadline");
  return {
    async reserve(
      request: ArtifactOwner & { sha256: string; sizeBytes: number; contentType?: string },
    ) {
      validate(request.sha256, request.sizeBytes);
      const artifactId = crypto.randomUUID();
      const objectKey = `reservations/${artifactId}/${request.sha256}`;
      const artifact = await store.reserveArtifact({
        ...request,
        artifactId,
        objectKey,
        expectedSha256: request.sha256,
        expectedSizeBytes: request.sizeBytes,
      });
      try {
        const uploadUrl = await objects.uploadUrl(
          objectKey,
          request.sizeBytes,
          request.contentType ?? "application/octet-stream",
          Buffer.from(request.sha256, "hex").toString("base64"),
        );
        return { ...artifact, objectKey, uploadUrl, expiresInSeconds: 300 };
      } catch (error) {
        try {
          await store.abandonArtifactReservation({ ...request, id: artifactId });
        } catch {
          if (error instanceof Error) Object.assign(error, { cleanupFailed: true });
        }
        throw error;
      }
    },
    async verify(request: VerificationRequest) {
      validate(request.sha256, request.sizeBytes);
      const claimId = crypto.randomUUID();
      const claimed = { ...request, claimId };
      const artifact = await store.claimArtifactVerification({
        ...claimed,
        claimSeconds: Math.ceil(verificationTimeoutMs / 1000),
      });
      const controller = new AbortController();
      let body: Readable | undefined;
      let terminal = false;
      let timedOut = false;
      let primaryError: unknown;
      const deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
        body?.destroy();
      }, verificationTimeoutMs);
      deadline.unref();
      try {
        const object = await objects.read(artifact.objectKey, controller.signal);
        body = object.body;
        if (controller.signal.aborted) throw conflict("artifact verification deadline exceeded");
        const hash = crypto.createHash("sha256");
        let actualSize = 0;
        let oversized =
          object.contentLength !== undefined && object.contentLength > request.sizeBytes;
        if (!oversized) {
          for await (const chunk of body) {
            if (!(chunk instanceof Uint8Array))
              throw new Error("Object storage returned non-byte data");
            actualSize += chunk.byteLength;
            if (actualSize > request.sizeBytes || actualSize > MAX_ARTIFACT_BYTES) {
              oversized = true;
              break;
            }
            hash.update(chunk);
            if (controller.signal.aborted)
              throw conflict("artifact verification deadline exceeded");
          }
        }
        if (oversized) {
          controller.abort();
          body.destroy();
          await store.rejectArtifactVerification({ ...claimed, quarantineKey: null });
          terminal = true;
          throw conflict("uploaded artifact exceeds its reserved size");
        }
        if (controller.signal.aborted) throw conflict("artifact verification deadline exceeded");
        if (
          actualSize !== request.sizeBytes ||
          hash.digest("hex") !== request.sha256 ||
          !object.versionId
        ) {
          let quarantineKey: string | null = null;
          if (object.versionId) {
            quarantineKey = `quarantine/${artifact.id}/${claimId}`;
            await objects.quarantine(
              artifact.objectKey,
              object.versionId,
              quarantineKey,
              controller.signal,
            );
          }
          await store.rejectArtifactVerification({ ...claimed, quarantineKey });
          terminal = true;
          throw conflict("uploaded artifact checksum, size, or immutable version is invalid");
        }
        const verified = await store.verifyArtifact({
          ...claimed,
          objectVersionId: object.versionId,
        });
        terminal = true;
        return verified;
      } catch (error) {
        primaryError =
          timedOut && !terminal
            ? conflict("artifact verification deadline exceeded")
            : error instanceof Error
              ? error
              : new Error("Artifact verification failed", { cause: error });
        throw primaryError;
      } finally {
        clearTimeout(deadline);
        controller.abort();
        body?.destroy();
        if (!terminal) {
          try {
            await store.releaseArtifactVerification(claimed);
          } catch {
            if (primaryError instanceof Error) Object.assign(primaryError, { cleanupFailed: true });
          }
        }
      }
    },
    async download({ artifact }: { artifact: ArtifactRecord }) {
      if (artifact.state !== "verified" || !artifact.objectVersionId)
        throw conflict("artifact is not verified with an immutable version");
      return {
        downloadUrl: await objects.downloadUrl(artifact.objectKey, artifact.objectVersionId),
        expiresInSeconds: 300,
      };
    },
  };
}
