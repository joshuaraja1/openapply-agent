import {
  DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import type { ArtifactStorePort, DataKeyPort } from "./candidate-vault.js";

const MAX_OBJECT_BYTES = 90 * 1024 * 1024;

export class KmsDataKeys implements DataKeyPort {
  constructor(private readonly client: KMSClient, private readonly keyId: string) {
    if (!keyId) throw new Error("A KMS key ARN is required");
  }

  async generate(context: Record<string, string>): Promise<{ plaintext: Uint8Array; wrapped: Uint8Array }> {
    const result = await this.client.send(new GenerateDataKeyCommand({
      KeyId: this.keyId, KeySpec: "AES_256", EncryptionContext: context,
    }));
    if (!result.Plaintext || !result.CiphertextBlob) throw new Error("KMS did not return a data key");
    return { plaintext: result.Plaintext, wrapped: result.CiphertextBlob };
  }

  async unwrap(wrapped: Uint8Array, context: Record<string, string>): Promise<Uint8Array> {
    const result = await this.client.send(new DecryptCommand({
      KeyId: this.keyId, CiphertextBlob: wrapped, EncryptionContext: context,
    }));
    if (!result.Plaintext) throw new Error("KMS did not unwrap the data key");
    return result.Plaintext;
  }
}

/** Use only with a private, versioned bucket. No public object ACLs or URLs. */
export class S3ArtifactStore implements ArtifactStorePort {
  constructor(private readonly client: S3Client, private readonly bucket: string) {
    if (!bucket) throw new Error("A private S3 bucket name is required");
  }

  async putCreateOnly(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: "application/vnd.openapply.encrypted+json",
      ServerSideEncryption: "AES256", IfNoneMatch: "*",
    }));
  }

  async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body || (result.ContentLength ?? 0) > MAX_OBJECT_BYTES) {
      throw new Error("Encrypted artifact is missing or oversized");
    }
    const reader = result.Body.transformToWebStream().getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_OBJECT_BYTES) throw new Error("Encrypted artifact is oversized");
        chunks.push(value);
      }
      return Buffer.concat(chunks, total);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async purgeVersions(prefix: string, exactKey: boolean): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    // Delete one bounded page at a time, then relist from the beginning.
    // Continuing with a marker after deleting that page can skip versions.
    for (let page = 0; page < 100; page++) {
      const result = await this.client.send(new ListObjectVersionsCommand({
        Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }));
      const objects = [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]
        .filter(item => item.Key && item.VersionId
          && (exactKey ? item.Key === prefix : item.Key.startsWith(prefix)))
        .map(item => ({ Key: item.Key!, VersionId: item.VersionId! }));
      if (objects.length) {
        const deleted = await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket, Delete: { Objects: objects, Quiet: true },
        }));
        if (deleted.Errors?.length) throw new Error("S3 could not delete every artifact version");
        keyMarker = undefined;
        versionIdMarker = undefined;
        continue;
      }
      if (!result.IsTruncated) return;
      if (!result.NextKeyMarker || (result.NextKeyMarker === keyMarker
        && result.NextVersionIdMarker === versionIdMarker)) {
        throw new Error("S3 version listing did not advance");
      }
      keyMarker = result.NextKeyMarker;
      versionIdMarker = result.NextVersionIdMarker;
    }
    throw new Error("S3 version purge needs another bounded retry");
  }
}
