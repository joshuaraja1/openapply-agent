import { describe, expect, it, vi } from "vitest";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { candidateArtifactSessionPolicy, issueCandidateArtifactCredentials,
  mintArtifactRunCapability, storeEncryptedReceipt, verifyArtifactRunCapability } from "../src/cloud/artifact-credential-broker.js";
import { requestScopedArtifactCredentials, uploadEncryptedReceipt } from "../src/cloud/aws-artifact-broker-client.js";
import { receiptObjectKey } from "../src/cloud/candidate-vault.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const otherCandidateId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const leaseToken = "00000000-0000-4000-8000-000000000005";
const subjectId = "subject-1";
const nowEpoch = 1795737600;
const secret = Buffer.alloc(32, 7);
const config = { dataRoleArn: "arn:aws:iam::123456789012:role/openapply-artifact-data",
  artifactBucket: "openapply-private-test", kmsKeyArn:
    "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000004" };
const receiptId = "00000000-0000-4000-8000-000000000006";
const encryptedReceipt = Buffer.from(JSON.stringify({ version: 1, candidateId,
  artifactId: receiptId, wrappedKey: Buffer.from("wrapped").toString("base64"),
  nonce: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"),
  ciphertext: Buffer.from("ciphertext").toString("base64") }));

function fixture() {
  const admission = { hasCurrentConsent: vi.fn(async () => true),
    hasArtifactGrantEligibility: vi.fn(async (_candidateId: string, _runId: string,
      _leaseToken: string, _checkedEpoch: number) => true),
    hasReceiptUploadEligibility: vi.fn(async (_candidateId: string, _runId: string,
      _leaseToken: string, _artifactId: string, _checkedEpoch: number) => true),
    loadIdentity: vi.fn(async () => ({ subjectId })) };
  const billing = { loadEntitlements: vi.fn(async () => [{ kind: "free-grant", subjectId,
    grantId: "beta", approvedBy: "admin", startsAt: "2026-11-25T00:00:00.000Z",
    endsAt: "2026-12-01T00:00:00.000Z", revokedAt: null }]) };
  const grantFence = { reserve: vi.fn(async () => {}) };
  const send = vi.fn(async (command: AssumeRoleCommand) => {
    expect(command).toBeInstanceOf(AssumeRoleCommand);
    return { Credentials: { AccessKeyId: "ASIATEST", SecretAccessKey: "secret",
      SessionToken: "session", Expiration: new Date((nowEpoch + 900) * 1000) } };
  });
  return { admission, billing, grantFence, clock: vi.fn(() => nowEpoch),
    sts: { send } as unknown as Pick<STSClient, "send">, send };
}

describe("candidate-scoped artifact credentials", () => {
  it("mints a bounded per-run capability and rejects tampering and expiry", () => {
    const token = mintArtifactRunCapability(candidateId, runId, secret, nowEpoch);
    expect(verifyArtifactRunCapability(token, secret, nowEpoch)).toMatchObject({ candidateId, runId });
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "Q" : "A"}`;
    expect(tampered).not.toBe(token);
    expect(() => verifyArtifactRunCapability(tampered, secret, nowEpoch)).toThrow();
    expect(() => verifyArtifactRunCapability(token, secret, nowEpoch + 1800)).toThrow();
    expect(() => mintArtifactRunCapability(otherCandidateId, runId, Buffer.alloc(16), nowEpoch)).toThrow();
  });

  it("issues only an exact-candidate S3 and KMS session policy after durable checks", async () => {
    const ports = fixture();
    const token = mintArtifactRunCapability(candidateId, runId, secret, nowEpoch);
    const grant = await issueCandidateArtifactCredentials(token, leaseToken, secret, nowEpoch, config, ports);
    expect(grant).toMatchObject({ candidateId, runId, leaseToken, accessKeyId: "ASIATEST" });
    expect(ports.admission.hasArtifactGrantEligibility).toHaveBeenCalledWith(candidateId, runId, leaseToken, nowEpoch);
    expect(ports.billing.loadEntitlements).toHaveBeenCalledWith(subjectId);
    expect(ports.grantFence.reserve).toHaveBeenCalledWith(candidateId, runId,
      leaseToken, nowEpoch);
    const command = ports.send.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(command.input.DurationSeconds).toBe(900);
    const policy = JSON.parse(command.input.Policy!);
    expect(policy.Statement[0].Resource).toBe(`arn:aws:s3:::openapply-private-test/candidates/${candidateId}/artifacts/*`);
    expect(policy.Statement[0].Action).toEqual(["s3:GetObject"]);
    expect(policy.Statement[1].Condition.StringEquals["kms:EncryptionContext:candidateId"]).toBe(candidateId);
    expect(policy.Statement[1].Action).not.toContain("kms:Encrypt");
    expect(JSON.stringify(policy)).not.toContain("s3:PutObject");
    expect(JSON.stringify(policy)).not.toContain("s3:DeleteObject");
  });

  it("does not call STS after consent or payment is revoked", async () => {
    const token = mintArtifactRunCapability(candidateId, runId, secret, nowEpoch);
    const withdrawn = fixture();
    withdrawn.admission.hasArtifactGrantEligibility.mockResolvedValueOnce(false);
    await expect(issueCandidateArtifactCredentials(token, leaseToken, secret, nowEpoch, config, withdrawn)).rejects.toThrow();
    expect(withdrawn.send).not.toHaveBeenCalled();
    const unpaid = fixture();
    unpaid.billing.loadEntitlements.mockResolvedValueOnce([] as never);
    await expect(issueCandidateArtifactCredentials(token, leaseToken, secret, nowEpoch, config, unpaid)).rejects.toThrow();
    expect(unpaid.send).not.toHaveBeenCalled();
    const racing = fixture();
    racing.admission.hasArtifactGrantEligibility.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(issueCandidateArtifactCredentials(token, leaseToken, secret, nowEpoch, config, racing)).rejects.toThrow();
    expect(racing.send).not.toHaveBeenCalled();
    const tombstoned = fixture();
    tombstoned.grantFence.reserve.mockRejectedValueOnce(new Error("tombstoned"));
    await expect(issueCandidateArtifactCredentials(token, leaseToken, secret,
      nowEpoch, config, tombstoned)).rejects.toThrow("tombstoned");
    expect(tombstoned.send).not.toHaveBeenCalled();
  });

  it("does not issue STS credentials if the lease expires during billing latency", async () => {
    const ports = fixture();
    const token = mintArtifactRunCapability(candidateId, runId, secret, nowEpoch);
    ports.clock.mockReturnValue(nowEpoch + 121);
    ports.admission.hasArtifactGrantEligibility.mockImplementation(async (_candidate, _run,
      _lease, checkedEpoch) => checkedEpoch < nowEpoch + 120);
    await expect(issueCandidateArtifactCredentials(token, leaseToken, secret,
      nowEpoch, config, ports)).rejects.toThrow("Task artifact access unavailable");
    expect(ports.admission.hasArtifactGrantEligibility).toHaveBeenLastCalledWith(
      candidateId, runId, leaseToken, nowEpoch + 121);
    expect(ports.grantFence.reserve).not.toHaveBeenCalled();
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("rejects unsafe configuration before STS", () => {
    expect(() => candidateArtifactSessionPolicy(candidateId, runId,
      { ...config, artifactBucket: "../other" })).toThrow();
    expect(() => candidateArtifactSessionPolicy(candidateId, runId,
      { ...config, kmsKeyArn: "*" })).toThrow();
  });

  it("accepts only a broker grant bound to the exact queued candidate and run", async () => {
    const grant = { candidateId, runId, leaseToken, accessKeyId: "ASIATEST0000",
      secretAccessKey: "secretsecret", sessionToken: "sessiontoken",
      expiresAt: new Date((nowEpoch + 900) * 1000).toISOString() };
    const send = vi.fn(async (command: InvokeCommand) => {
      expect(command).toBeInstanceOf(InvokeCommand);
      expect(command.input.InvocationType).toBe("RequestResponse");
      expect(JSON.parse(new TextDecoder().decode(command.input.Payload as Uint8Array)))
        .toEqual({ kind: "credentials", capability: "capability", leaseToken });
      return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(grant)) };
    });
    const lambda = { send } as unknown as Pick<LambdaClient, "send">;
    const arn = "arn:aws:lambda:us-east-1:123456789012:function:openapply-staging-artifact-broker";
    expect(await requestScopedArtifactCredentials(lambda, arn, "capability",
      { candidateId, runId, leaseToken }, new Date(nowEpoch * 1000))).toEqual(grant);
    await expect(requestScopedArtifactCredentials(lambda, arn, "capability",
      { candidateId: otherCandidateId, runId, leaseToken }, new Date(nowEpoch * 1000))).rejects.toThrow();
    await expect(requestScopedArtifactCredentials(lambda, arn, "capability",
      { candidateId, runId, leaseToken: otherCandidateId }, new Date(nowEpoch * 1000))).rejects.toThrow();
  });

  it("broker writes only the reserved receipt once and never hands S3 Put to worker", async () => {
    const ports = fixture();
    const stored = new Map<string, Buffer>();
    const receipts = { putCreateOnly: vi.fn(async (key: string, bytes: Uint8Array) => {
      if (stored.has(key)) throw new Error("PreconditionFailed");
      stored.set(key, Buffer.from(bytes));
    }) };
    const token = mintArtifactRunCapability(candidateId, runId, secret, nowEpoch);
    const input = [token, leaseToken, receiptId, encryptedReceipt,
      secret, nowEpoch, config] as const;
    expect(await storeEncryptedReceipt(...input, { ...ports, receipts }))
      .toEqual({ candidateId, runId, artifactId: receiptId });
    const key = receiptObjectKey(candidateId, runId, receiptId);
    expect(stored.get(key)).toEqual(encryptedReceipt);
    await expect(storeEncryptedReceipt(...input, { ...ports, receipts }))
      .rejects.toThrow("PreconditionFailed");
    expect(stored.get(key)).toEqual(encryptedReceipt);
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("rejects missing intent, wrong receipt ID, revoked access, and deletion before write", async () => {
    const token = mintArtifactRunCapability(candidateId, runId, secret, nowEpoch);
    const receipts = { putCreateOnly: vi.fn(async () => {}) };
    const noIntent = fixture();
    noIntent.admission.hasReceiptUploadEligibility.mockResolvedValue(false);
    await expect(storeEncryptedReceipt(token, leaseToken, receiptId, encryptedReceipt,
      secret, nowEpoch, config, { ...noIntent, receipts })).rejects.toThrow();
    const unpaid = fixture();
    unpaid.billing.loadEntitlements.mockResolvedValue([] as never);
    await expect(storeEncryptedReceipt(token, leaseToken, receiptId, encryptedReceipt,
      secret, nowEpoch, config, { ...unpaid, receipts })).rejects.toThrow();
    const deleted = fixture();
    deleted.grantFence.reserve.mockRejectedValue(new Error("tombstoned"));
    await expect(storeEncryptedReceipt(token, leaseToken, receiptId, encryptedReceipt,
      secret, nowEpoch, config, { ...deleted, receipts })).rejects.toThrow();
    await expect(storeEncryptedReceipt(token, leaseToken, otherCandidateId, encryptedReceipt,
      secret, nowEpoch, config, { ...fixture(), receipts })).rejects.toThrow();
    expect(receipts.putCreateOnly).not.toHaveBeenCalled();
  });

  it("client accepts only exact broker receipt acknowledgment", async () => {
    const arn = "arn:aws:lambda:us-east-1:123456789012:function:openapply-staging-artifact-broker";
    const send = vi.fn(async (command: InvokeCommand) => {
      const payload = JSON.parse(new TextDecoder().decode(command.input.Payload as Uint8Array));
      expect(payload).toMatchObject({ kind: "receipt-upload", capability: "capability",
        leaseToken, artifactId: receiptId });
      expect(Buffer.from(payload.bodyBase64, "base64")).toEqual(encryptedReceipt);
      return { StatusCode: 200, Payload: Buffer.from(JSON.stringify({ candidateId,
        runId, artifactId: receiptId })) };
    });
    const lambda = { send } as unknown as Pick<LambdaClient, "send">;
    await uploadEncryptedReceipt(lambda, arn, "capability",
      { candidateId, runId, leaseToken, artifactId: receiptId }, encryptedReceipt);
    await expect(uploadEncryptedReceipt(lambda, arn, "capability",
      { candidateId: otherCandidateId, runId, leaseToken, artifactId: receiptId },
      encryptedReceipt)).rejects.toThrow();
  });
});
