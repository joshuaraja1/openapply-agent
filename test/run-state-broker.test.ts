import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GetCommand, QueryCommand, TransactWriteCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { executeRunStateRequest } from "../src/cloud/run-state-broker.js";
import { mintArtifactRunCapability } from "../src/cloud/artifact-credential-broker.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const otherCandidateId = "00000000-0000-4000-8000-000000000009";
const runId = "00000000-0000-4000-8000-000000000002";
const now = 1_800_000_000;
const secret = Buffer.alloc(32, 7);
const capability = mintArtifactRunCapability(candidateId, runId, secret, now);
const job = { provider: "greenhouse", employerId: "acme", requisitionId: "42" };
const fixture = { provider: "synthetic", employerId: "fixture", requisitionId: "alpha" };
const config = { ledgerTable: "openapply-staging-run-ledger", entitlementTable: "entitlements" };

function db(synthetic = false, paid = false) {
  const seen: unknown[] = [];
  const send = vi.fn(async (command: unknown) => {
    seen.push(command);
    if (command instanceof QueryCommand && paid) return { Items: [{ pk: "SUBJECT#user-1",
      sk: "ENTITLEMENT#grant", record: { kind: "free-grant", subjectId: "user-1",
        grantId: "synthetic", approvedBy: "staging", startsAt: "2020-01-01T00:00:00Z",
        endsAt: "2099-01-01T00:00:00Z", revokedAt: null } }] };
    if (command instanceof TransactWriteCommand && paid) return {};
    if (!(command instanceof GetCommand)) throw new Error("Unexpected write");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk !== `CANDIDATE#${candidateId}`) throw new Error("Cross-candidate read");
    if (key.sk === `TASK#${runId}`) return { Item: { pk: key.pk, sk: key.sk,
      candidateId, runId, capability, state: "started" } };
    if (key.sk === "DELETED") return { Item: undefined };
    if (key.sk === `RUN#${runId}`) return { Item: { pk: key.pk, sk: key.sk,
      candidateId, runId, subjectId: "user-1", consentVersion: 1,
      profileArtifactId: "00000000-0000-4000-8000-000000000003", job: synthetic ? fixture : job } };
    if (key.sk.startsWith("JOB#") && synthetic) return { Item: { syntheticClickAttempts: 1 } };
    throw new Error(`Unexpected key ${key.sk}`);
  });
  return { seen, send, client: { send } as unknown as DynamoDBDocumentClient };
}

describe("trusted run state broker", () => {
  it("derives the candidate partition from the signed capability", async () => {
    const store = db();
    await expect(executeRunStateRequest({ operation: "loadIdentity" }, capability,
      secret, now, store.client, config)).resolves.toEqual({ subjectId: "user-1",
      consentVersion: 1, job });
    expect(store.seen).toHaveLength(3);
    expect(store.seen.every(command => (command as GetCommand).input.Key?.pk
      === `CANDIDATE#${candidateId}`)).toBe(true);
  });

  it("rejects caller-supplied tenant identifiers and another billing subject", async () => {
    const store = db();
    await expect(executeRunStateRequest({ operation: "loadIdentity",
      candidateId: otherCandidateId }, capability, secret, now, store.client, config)).rejects.toThrow();
    expect(store.send).not.toHaveBeenCalled();
    await expect(executeRunStateRequest({ operation: "loadEntitlements",
      subjectId: "user-2" }, capability, secret, now, store.client, config))
      .rejects.toThrow("Billing subject scope mismatch");
    expect(store.seen.every(command => (command as GetCommand).input.Key?.pk
      === `CANDIDATE#${candidateId}`)).toBe(true);
  });

  it("rejects a different capability for the same run before journal operations", async () => {
    const store = db();
    await expect(executeRunStateRequest({ operation: "acquireLease" },
      mintArtifactRunCapability(candidateId, runId, secret, now), secret, now,
      store.client, config)).rejects.toThrow();
    expect(store.seen).toHaveLength(2);
  });

  it("reads only the signed candidate's synthetic click audit and rejects another job", async () => {
    const store = db(true);
    await expect(executeRunStateRequest({ operation: "readSyntheticClickAttempts", job: fixture },
      capability, secret, now, store.client, config)).resolves.toBe(1);
    expect(store.seen.every(command => (command as GetCommand).input.Key?.pk
      === `CANDIDATE#${candidateId}`)).toBe(true);
    await expect(executeRunStateRequest({ operation: "readSyntheticClickAttempts",
      job: { ...fixture, requisitionId: "other" } }, capability, secret, now, store.client, config))
      .rejects.toThrow("Run job scope mismatch");
    await expect(executeRunStateRequest({ operation: "readSyntheticClickAttempts",
      job: { ...fixture, candidateId: otherCandidateId } }, capability, secret, now,
      store.client, config)).rejects.toThrow();
  });

  it("issues a synthetic click audit only through the exact capability and leased job", async () => {
    const store = db(true, true);
    const leaseToken = "00000000-0000-4000-8000-000000000004";
    await expect(executeRunStateRequest({ operation: "recordSyntheticFinalClick",
      leaseToken, job: fixture }, capability, secret, now, store.client, config))
      .resolves.toBe(true);
    const write = store.seen.find(command => command instanceof TransactWriteCommand) as TransactWriteCommand;
    expect(write.input.TransactItems).toHaveLength(4);
    expect(write.input.TransactItems?.every(item => {
      const key = item.Update?.Key ?? item.ConditionCheck?.Key;
      return key?.pk === `CANDIDATE#${candidateId}`;
    })).toBe(true);
    const click = write.input.TransactItems?.find(item => item.Update)?.Update;
    expect(click?.UpdateExpression).toBe("SET syntheticClickAttempts = :one");
    expect(click?.ConditionExpression).toContain("attribute_not_exists(syntheticClickAttempts)");
    await expect(executeRunStateRequest({ operation: "recordSyntheticFinalClick",
      leaseToken, job: { ...fixture, requisitionId: "other" } }, capability,
      secret, now, store.client, config)).rejects.toThrow("Run job scope mismatch");
  });

  it("does not give browser tasks direct shared-table or queue permissions", () => {
    const template = readFileSync(fileURLToPath(new URL("../deploy/aws/synthetic-queue-task.yaml",
      import.meta.url)), "utf8");
    const role = template.split("  SyntheticQueueTaskRole:")[1]?.split("  SyntheticQueueTask:")[0];
    expect(role).toBeDefined();
    expect(role).toContain("lambda:InvokeFunction");
    expect(role).not.toMatch(/Action:.*(?:dynamodb:|sqs:|s3:|kms:)/i);
  });
});
