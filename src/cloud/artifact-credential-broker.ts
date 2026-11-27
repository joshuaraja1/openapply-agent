import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";
import { requireHostedAccess } from "../hosted/entitlement.js";
import { receiptObjectKey } from "./candidate-vault.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const capabilitySchema = z.strictObject({
  version: z.literal(1), candidateId: uuid, runId: uuid,
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
export type ArtifactRunCapability = z.infer<typeof capabilitySchema>;

function signingKey(value: Uint8Array): Uint8Array {
  if (value.byteLength < 32) throw new Error("Artifact broker signing key is too short");
  return value;
}

function freshEpoch(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Artifact broker clock unavailable");
  return value;
}

/** A trusted task launcher passes this bearer capability in ECS task overrides,
 * never in SQS, logs, or candidate-visible URLs. */
export function mintArtifactRunCapability(candidateId: string, runId: string,
  secret: Uint8Array, nowEpoch: number, lifetimeSeconds = 1800): string {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0
    || !Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 1800) {
    throw new Error("Invalid task capability lifetime");
  }
  const claims = capabilitySchema.parse({ version: 1, candidateId, runId,
    issuedAt: nowEpoch, expiresAt: nowEpoch + lifetimeSeconds,
    nonce: randomBytes(16).toString("base64url") });
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingKey(secret)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyArtifactRunCapability(token: string, secret: Uint8Array,
  nowEpoch: number): ArtifactRunCapability {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0 || token.length > 800) {
    throw new Error("Task capability unavailable");
  }
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) throw new Error("Task capability unavailable");
  const actual = Buffer.from(match[2]!, "base64url");
  const expected = createHmac("sha256", signingKey(secret)).update(match[1]!).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Task capability unavailable");
  }
  const bytes = Buffer.from(match[1]!, "base64url");
  if (bytes.toString("base64url") !== match[1] || bytes.length > 512) {
    throw new Error("Task capability unavailable");
  }
  const claims = capabilitySchema.parse(JSON.parse(bytes.toString("utf8")));
  if (claims.issuedAt > nowEpoch + 30 || claims.expiresAt <= nowEpoch
    || claims.expiresAt - claims.issuedAt > 1800) {
    throw new Error("Task capability unavailable");
  }
  return claims;
}

export interface ArtifactBrokerConfiguration {
  dataRoleArn: string;
  artifactBucket: string;
  kmsKeyArn: string;
}

/** The assumed role has a bucket/key ceiling of its own. This inline session
 * policy intersects that ceiling and narrows one task to one candidate. */
export function candidateArtifactSessionPolicy(candidateId: string, runId: string,
  config: ArtifactBrokerConfiguration): string {
  const id = uuid.parse(candidateId);
  const run = uuid.parse(runId);
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(config.artifactBucket)
    || !/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/.test(config.kmsKeyArn)) {
    throw new Error("Artifact broker storage configuration is invalid");
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: ["s3:GetObject"],
      Resource: `arn:aws:s3:::${config.artifactBucket}/candidates/${id}/artifacts/*` },
    { Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey"],
      Resource: config.kmsKeyArn,
      Condition: { StringEquals: {
        "kms:EncryptionContext:application": "openapply",
        "kms:EncryptionContext:version": "1",
        "kms:EncryptionContext:candidateId": id,
      }, Null: { "kms:EncryptionContext:artifactId": "false" } } },
  ] });
}

const receiptEnvelopeSchema = z.strictObject({ version: z.literal(1),
  candidateId: uuid, artifactId: uuid,
  wrappedKey: z.string().min(1).max(12_000), nonce: z.string().min(1).max(32),
  tag: z.string().min(1).max(32), ciphertext: z.string().min(1).max(1_500_000) });
const MAX_RECEIPT_ENVELOPE_BYTES = 1_600_000;
function canonicalBase64(value: string, minBytes: number, maxBytes: number): boolean {
  const bytes = Buffer.from(value, "base64");
  return bytes.length >= minBytes && bytes.length <= maxBytes
    && bytes.toString("base64") === value;
}

/** The worker has no S3 Put permission. The broker alone performs this exact
 * create-only write after confirming the reserved submit-intent receipt ID. */
export async function storeEncryptedReceipt(token: string, leaseToken: string,
  artifactId: string, body: Uint8Array, secret: Uint8Array, nowEpoch: number,
  config: ArtifactBrokerConfiguration, ports: {
    admission: {
      hasReceiptUploadEligibility(candidateId: string, runId: string,
        leaseToken: string, artifactId: string, nowEpoch: number): Promise<boolean>;
      loadIdentity(candidateId: string, runId: string): Promise<{ subjectId: string }>;
    };
    billing: { loadEntitlements(subjectId: string): Promise<readonly unknown[]> };
    grantFence: { reserve(candidateId: string, nowEpoch: number): Promise<void> };
    receipts: { putCreateOnly(key: string, body: Uint8Array): Promise<void> };
  }): Promise<{ candidateId: string; runId: string; artifactId: string }> {
  const claims = verifyArtifactRunCapability(token, secret, nowEpoch);
  uuid.parse(leaseToken);
  uuid.parse(artifactId);
  if (body.byteLength === 0 || body.byteLength > MAX_RECEIPT_ENVELOPE_BYTES) {
    throw new Error("Receipt envelope unavailable");
  }
  let envelope: z.infer<typeof receiptEnvelopeSchema>;
  try { envelope = receiptEnvelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))); }
  catch { throw new Error("Receipt envelope unavailable"); }
  if (envelope.candidateId !== claims.candidateId || envelope.artifactId !== artifactId) {
    throw new Error("Receipt envelope identity mismatch");
  }
  if (!canonicalBase64(envelope.wrappedKey, 1, 8192)
    || !canonicalBase64(envelope.nonce, 12, 12)
    || !canonicalBase64(envelope.tag, 16, 16)
    || !canonicalBase64(envelope.ciphertext, 1, 1024 * 1024)) {
    throw new Error("Receipt envelope unavailable");
  }
  if (!await ports.admission.hasReceiptUploadEligibility(claims.candidateId, claims.runId,
    leaseToken, artifactId, nowEpoch)) throw new Error("Receipt upload unavailable");
  const run = await ports.admission.loadIdentity(claims.candidateId, claims.runId);
  requireHostedAccess(run.subjectId, await ports.billing.loadEntitlements(run.subjectId),
    new Date(nowEpoch * 1000));
  if (!await ports.admission.hasReceiptUploadEligibility(claims.candidateId, claims.runId,
    leaseToken, artifactId, nowEpoch)) throw new Error("Receipt upload unavailable");
  await ports.grantFence.reserve(claims.candidateId, nowEpoch);
  await ports.receipts.putCreateOnly(receiptObjectKey(claims.candidateId, claims.runId,
    artifactId), body);
  return { candidateId: claims.candidateId, runId: claims.runId, artifactId };
}

export interface ScopedArtifactCredentials {
  candidateId: string;
  runId: string;
  leaseToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: string;
}

/** Broker is the only principal allowed to assume the data role. The task
 * role cannot call S3/KMS directly and cannot mint another candidate's token. */
export async function issueCandidateArtifactCredentials(token: string, leaseToken: string,
  secret: Uint8Array, nowEpoch: number, config: ArtifactBrokerConfiguration,
  ports: {
    admission: {
      hasCurrentConsent(candidateId: string, runId: string): Promise<boolean>;
      hasArtifactGrantEligibility(candidateId: string, runId: string,
        leaseToken: string, nowEpoch: number): Promise<boolean>;
      loadIdentity(candidateId: string, runId: string): Promise<{ subjectId: string }>;
    };
    billing: { loadEntitlements(subjectId: string): Promise<readonly unknown[]> };
    grantFence: { reserve(candidateId: string, runId: string,
      leaseToken: string, nowEpoch: number): Promise<void> };
    clock: () => number;
    sts: Pick<STSClient, "send">;
  }): Promise<ScopedArtifactCredentials> {
  const claims = verifyArtifactRunCapability(token, secret, nowEpoch);
  uuid.parse(leaseToken);
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/.test(config.dataRoleArn)) {
    throw new Error("Artifact broker role configuration is invalid");
  }
  if (!await ports.admission.hasArtifactGrantEligibility(claims.candidateId, claims.runId,
    leaseToken, nowEpoch)) {
    throw new Error("Task artifact access unavailable");
  }
  const run = await ports.admission.loadIdentity(claims.candidateId, claims.runId);
  const entitlements = await ports.billing.loadEntitlements(run.subjectId);
  const finalEpoch = freshEpoch(ports.clock);
  verifyArtifactRunCapability(token, secret, finalEpoch);
  requireHostedAccess(run.subjectId, entitlements, new Date(finalEpoch * 1000));
  if (!await ports.admission.hasArtifactGrantEligibility(claims.candidateId, claims.runId,
    leaseToken, finalEpoch)) {
    throw new Error("Task artifact access unavailable");
  }
  // Deletion observes this row before it can purge. A failed reservation must
  // never result in an STS credential, even if all prior checks succeeded.
  await ports.grantFence.reserve(claims.candidateId, claims.runId, leaseToken, finalEpoch);
  const result = await ports.sts.send(new AssumeRoleCommand({
    RoleArn: config.dataRoleArn,
    RoleSessionName: `oa-${claims.runId.slice(0, 8)}`,
    DurationSeconds: 900,
    Policy: candidateArtifactSessionPolicy(claims.candidateId, claims.runId, config),
  }));
  const credentials = result.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken
    || !credentials.Expiration || credentials.Expiration.getTime() <= (finalEpoch + 60) * 1000) {
    throw new Error("Scoped artifact credentials unavailable");
  }
  return { candidateId: claims.candidateId, runId: claims.runId, leaseToken,
    accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken, expiresAt: credentials.Expiration.toISOString() };
}
