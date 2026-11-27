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
});
