import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const idSchema = z.uuid();
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  candidateId: idSchema,
  artifactId: idSchema,
  wrappedKey: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 90 * 1024 * 1024;

export interface DataKeyPort {
  generate(context: Record<string, string>): Promise<{ plaintext: Uint8Array; wrapped: Uint8Array }>;
  unwrap(wrapped: Uint8Array, context: Record<string, string>): Promise<Uint8Array>;
}

export interface ArtifactStorePort {
  /** Atomic create; reject if this artifact ID already has a current object. */
  putCreateOnly(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Permanently remove all versions, including delete markers, under this prefix. */
  purgeVersions(prefix: string, exactKey: boolean): Promise<void>;
}

function canonicalId(id: string): string {
  const parsed = idSchema.parse(id);
  if (parsed !== parsed.toLowerCase()) throw new Error("Cloud candidate and artifact IDs must be lowercase UUIDs");
  return parsed;
}

function candidatePrefix(candidateId: string): string {
  return `candidates/${canonicalId(candidateId)}/`;
}

export function artifactObjectKey(candidateId: string, artifactId: string): string {
  return `${candidatePrefix(candidateId)}artifacts/${canonicalId(artifactId)}`;
}

function encryptionContext(candidateId: string, artifactId: string): Record<string, string> {
  return { application: "openapply", version: "1", candidateId, artifactId };
}

function aad(candidateId: string, artifactId: string): Buffer {
  return Buffer.from(`openapply:v1:${candidateId}:${artifactId}`, "utf8");
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error("Encrypted artifact field is oversized");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== value) {
    throw new Error("Encrypted artifact field is malformed");
  }
  return bytes;
}

/** The caller owns and must zero the plaintext returned by read(). */
export class CandidateVault {
  constructor(private readonly keys: DataKeyPort, private readonly objects: ArtifactStorePort) {}

  async put(candidateIdInput: string, artifactIdInput: string, plaintext: Uint8Array): Promise<void> {
    const candidateId = canonicalId(candidateIdInput);
    const artifactId = canonicalId(artifactIdInput);
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("Artifact exceeds the staging size limit");
    const context = encryptionContext(candidateId, artifactId);
    const dataKey = await this.keys.generate(context);
    try {
      if (dataKey.plaintext.byteLength !== 32 || dataKey.wrapped.byteLength === 0) {
        throw new Error("KMS returned an invalid data key");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey.plaintext, nonce);
      cipher.setAAD(aad(candidateId, artifactId));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const body = Buffer.from(JSON.stringify({
        version: 1,
        candidateId,
        artifactId,
        wrappedKey: Buffer.from(dataKey.wrapped).toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }));
      await this.objects.putCreateOnly(artifactObjectKey(candidateId, artifactId), body);
    } finally {
      dataKey.plaintext.fill(0);
    }
  }

  async read(candidateIdInput: string, artifactIdInput: string): Promise<Buffer> {
    const candidateId = canonicalId(candidateIdInput);
    const artifactId = canonicalId(artifactIdInput);
    const bytes = await this.objects.get(artifactObjectKey(candidateId, artifactId));
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error("Encrypted artifact exceeds the staging size limit");
    const envelope = envelopeSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (envelope.candidateId !== candidateId || envelope.artifactId !== artifactId) {
      throw new Error("Encrypted artifact identity does not match requested candidate and artifact");
    }
    const nonce = decodeBase64(envelope.nonce, 12);
    const tag = decodeBase64(envelope.tag, 16);
    const wrapped = decodeBase64(envelope.wrappedKey, 8192);
    const ciphertext = decodeBase64(envelope.ciphertext, MAX_PLAINTEXT_BYTES);
    if (nonce.length !== 12 || tag.length !== 16 || wrapped.length === 0) {
      throw new Error("Encrypted artifact header is malformed");
    }
    const key = await this.keys.unwrap(wrapped, encryptionContext(candidateId, artifactId));
    try {
      if (key.byteLength !== 32) throw new Error("KMS returned an invalid data key");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(aad(candidateId, artifactId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } finally {
      key.fill(0);
    }
  }

  async restoreToPrivateTemp(candidateId: string, artifactId: string): Promise<{
    path: string;
    cleanup(): Promise<void>;
  }> {
    const plaintext = await this.read(candidateId, artifactId);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "openapply-cloud-restore-"));
      const path = join(directory, "artifact");
      await writeFile(path, plaintext, { flag: "wx", mode: 0o600 });
      const privateDirectory = directory;
      return { path, cleanup: () => rm(privateDirectory, { recursive: true, force: true }) };
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }

  async deleteArtifact(candidateId: string, artifactId: string): Promise<void> {
    await this.objects.purgeVersions(artifactObjectKey(candidateId, artifactId), true);
  }

  /** Caller must first stop candidate workers and revoke writes. */
  async deleteCandidate(candidateId: string): Promise<void> {
    await this.objects.purgeVersions(candidatePrefix(candidateId), false);
  }
}
