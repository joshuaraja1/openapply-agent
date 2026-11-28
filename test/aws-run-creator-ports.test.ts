import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { DynamoTrustedRunCreator } from "../src/cloud/aws-run-creator-ports.js";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import type { TrustedRunRecord, VerifiedOfficialLead } from "../src/cloud/hosted-run-creator.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const leadId = "00000000-0000-4000-8000-000000000003";
const artifactId = "00000000-0000-4000-8000-000000000004";
const job = { provider: "greenhouse", employerId: "employer", requisitionId: "42" };
const lead: VerifiedOfficialLead = { leadId, job, jobKey: officialJobKey(job),
  canonicalUrl: "https://jobs.example.com/42", expiresAt: 2000000000 };
const record: TrustedRunRecord = { candidateId, runId, subjectId: "subject",
  leadId, job, jobKey: lead.jobKey, profileArtifactId: artifactId,
  consentVersion: 1, policyVersion: "v1", createdAt: "2026-11-26T00:00:00.000Z" };
const pk = `CANDIDATE#${candidateId}`;

function fixture(send: (command: GetCommand | TransactWriteCommand) => Promise<unknown>) {
  const s3send = vi.fn(async (_command: HeadObjectCommand) => ({
    ContentType: "application/vnd.openapply.encrypted+json" }));
  const port = new DynamoTrustedRunCreator({ send } as unknown as
    Pick<DynamoDBDocumentClient, "send">, { send: s3send } as unknown as
    Pick<S3Client, "send">, "ledger", "private-bucket");
  return { port, s3send };
}

describe("Dynamo trusted run creator", () => {
  it("loads only a reviewed, ready application profile marker", async () => {
    const { port } = fixture(async () => ({ Item: { pk, sk: `PROFILE#${artifactId}`,
      status: "verified", candidateId, artifactId, subjectId: "subject",
      applicationProfileReady: true } }));
    expect(await port.loadProfile(candidateId, artifactId)).toMatchObject({
      candidateId, artifactId, subjectId: "subject", applicationProfileReady: true,
    });
  });

  it("does not accept a legacy verified marker without a reviewed application profile", async () => {
    const { port } = fixture(async () => ({ Item: { pk, sk: `PROFILE#${artifactId}`,
      status: "verified", candidateId, artifactId, subjectId: "subject" } }));
    expect(await port.loadProfile(candidateId, artifactId)).toBeUndefined();
  });

  it("treats malformed stored lead and profile rows as unavailable", async () => {
    const { port } = fixture(async command => ({ Item: command instanceof GetCommand
      && command.input.Key?.sk === "VERIFIED"
      ? { pk: `LEAD#${leadId}`, sk: "VERIFIED", status: "open", ...lead,
          canonicalUrl: "not-a-url" }
      : { pk, sk: `PROFILE#${artifactId}`, status: "verified", candidateId,
          artifactId, subjectId: "", applicationProfileReady: true } }));
    expect(await port.loadLead(leadId)).toBeUndefined();
    expect(await port.loadProfile(candidateId, artifactId)).toBeUndefined();
  });

  it("atomically checks deletion, lead and profile before writing run and scoped consent", async () => {
    const commands: (GetCommand | TransactWriteCommand)[] = [];
    const { port, s3send } = fixture(async command => { commands.push(command); return {}; });
    expect(await port.createOrGet(record, lead, 1795651200)).toBe("created");
    const transaction = commands[0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    const items = transaction.input.TransactItems!;
    expect(items).toHaveLength(5);
    expect(items[0]?.ConditionCheck?.Key).toEqual({ pk, sk: "DELETED" });
    expect(items[1]?.ConditionCheck?.Key).toEqual({ pk: `LEAD#${leadId}`, sk: "VERIFIED" });
    expect(items[2]?.ConditionCheck?.Key).toEqual({ pk, sk: `PROFILE#${artifactId}` });
    expect(items[2]?.ConditionCheck?.ConditionExpression).toContain("applicationProfileReady = :ready");
    expect(items[2]?.ConditionCheck?.ExpressionAttributeValues).toMatchObject({ ":ready": true });
    expect(items[3]?.Put?.Item?.sk).toBe(`RUN#${runId}`);
    expect(items[4]?.Put?.Item).toMatchObject({ pk, sk: `CONSENT#${runId}`,
      runId, state: "granted", scope: "apply-one-job", version: 1 });
    expect(await port.profileObjectExists(candidateId, artifactId)).toBe(true);
    expect(s3send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("accepts an exact committed retry but rejects a reused run ID", async () => {
    const run = { pk, sk: `RUN#${runId}`, ...record };
    const consent = { pk, sk: `CONSENT#${runId}`, runId, state: "granted",
      version: 1, scope: "apply-one-job", policyVersion: "v1" };
    const existing = fixture(async command => {
      if (command instanceof TransactWriteCommand) throw Object.assign(new Error(), {
        name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      if (command instanceof GetCommand) return { Item: command.input.Key?.sk === run.sk ? run
        : command.input.Key?.sk === consent.sk ? consent : undefined };
      return {};
    });
    expect(await existing.port.createOrGet(record, lead, 1795651200)).toBe("existing");
    await expect(existing.port.createOrGet({ ...record, leadId: artifactId }, lead, 1795651200))
      .rejects.toThrow("Run ID already used");
  });
  it("atomically fences a reviewed retry against old intent, consent withdrawal and an active task", async () => {
    const commands: (GetCommand | TransactWriteCommand)[] = [];
    const { port } = fixture(async command => { commands.push(command); return {}; });
    const blockedRunId = "00000000-0000-4000-8000-000000000009";
    const oldProfileArtifactId = "00000000-0000-4000-8000-000000000008";
    await port.createOrGet(record, lead, 1795651200,
      { blockedRunId, oldProfileArtifactId });
    const tx = (commands[0] as TransactWriteCommand).input.TransactItems!;
    expect(tx).toHaveLength(10);
    expect(tx[3]?.Update?.Key).toEqual({ pk, sk: `DISPATCH#${blockedRunId}` });
    expect(tx[3]?.Update?.ConditionExpression).toContain("#state=:human");
    expect(tx[3]?.Update?.ConditionExpression).toContain("attribute_not_exists(reviewedRetryRunId)");
    expect(tx[3]?.Update?.ExpressionAttributeValues?.[":newRun"]).toBe(runId);
    expect(tx[4]?.ConditionCheck?.Key).toEqual({ pk, sk: `RUN#${blockedRunId}` });
    expect(tx[5]?.ConditionCheck?.Key).toEqual({ pk, sk: `CONSENT#${blockedRunId}` });
    expect(tx[5]?.ConditionCheck?.ConditionExpression).toContain("#state=:granted");
    expect(tx[6]?.ConditionCheck?.Key).toEqual({ pk, sk: officialJobKey(job) });
    expect(tx[6]?.ConditionCheck?.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(tx[7]?.ConditionCheck?.Key).toEqual({ pk, sk: "ACTIVE_TASK" });
    expect(tx[7]?.ConditionCheck?.ConditionExpression).toBe("attribute_not_exists(pk)");
  });
  it("accepts one reviewed retry ID and rejects a competing new run ID", async () => {
    const blockedRunId = "00000000-0000-4000-8000-000000000009";
    let linkedRun: string | undefined;
    const { port } = fixture(async command => {
      if (command instanceof TransactWriteCommand) {
        const update = command.input.TransactItems?.[3]?.Update;
        const proposed = update?.ExpressionAttributeValues?.[":newRun"] as string;
        if (linkedRun && linkedRun !== proposed) throw Object.assign(new Error(), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        });
        linkedRun = proposed;
        return {};
      }
      return { Item: command.input.Key?.sk === `DISPATCH#${blockedRunId}`
        ? { reviewedRetryRunId: linkedRun } : undefined };
    });
    const review = { blockedRunId,
      oldProfileArtifactId: "00000000-0000-4000-8000-000000000008" };
    expect(await port.createOrGet(record, lead, 1795651200, review)).toBe("created");
    expect(linkedRun).toBe(runId);
    await expect(port.createOrGet({ ...record,
      runId: "00000000-0000-4000-8000-00000000000a" }, lead, 1795651200, review))
      .rejects.toThrow();
    expect(linkedRun).toBe(runId);
  });
});
