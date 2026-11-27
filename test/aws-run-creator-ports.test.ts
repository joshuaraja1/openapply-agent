import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { DynamoTrustedRunCreator } from "../src/cloud/aws-run-creator-ports.js";
import type { CandidateVault } from "../src/cloud/candidate-vault.js";
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

const resumeId = "00000000-0000-4000-8000-000000000005";
const transcriptId = "00000000-0000-4000-8000-000000000006";
function profile(documents: { resumeId?: string; transcriptId?: string; candidateId?: string } = {}) {
  return Buffer.from(JSON.stringify({ version: 1, provenance: "candidate-entered-and-reviewed",
    candidateId: documents.candidateId ?? candidateId,
    masterResume: { artifactId: documents.resumeId ?? resumeId,
      name: "resume.pdf", mimeType: "application/pdf" },
    ...(documents.transcriptId ? { transcript: { artifactId: documents.transcriptId,
      name: "transcript.pdf", mimeType: "application/pdf" } } : {}),
    consent: { storage: true, automation: true, reviewed: true } }));
}

function fixture(send: (command: GetCommand | TransactWriteCommand) => Promise<unknown>,
  overrides: { profile?: Buffer; missingKey?: string; wrongContentTypeKey?: string;
    corruptPdfKey?: string } = {}) {
  const s3send = vi.fn(async (command: HeadObjectCommand) => {
    if (command.input.Key === overrides.missingKey) throw Object.assign(new Error("missing"), { name: "NotFound" });
    return { ContentType: command.input.Key === overrides.wrongContentTypeKey ? "text/plain"
      : "application/vnd.openapply.encrypted+json", ContentLength: 1024 };
  });
  const vaultRead = vi.fn(async (_candidateId: string, id: string) => id === artifactId
    ? Buffer.from(overrides.profile ?? profile())
    : Buffer.from(id === overrides.corruptPdfKey ? "not a PDF" : "%PDF-1.4\nvalid"));
  const port = new DynamoTrustedRunCreator({ send } as unknown as
    Pick<DynamoDBDocumentClient, "send">, { send: s3send } as unknown as
    Pick<S3Client, "send">, { read: vaultRead } as Pick<CandidateVault, "read">,
    "ledger", "private-bucket");
  return { port, s3send, vaultRead };
}

describe("Dynamo trusted run creator", () => {
  it("treats malformed stored lead and profile rows as unavailable", async () => {
    const { port } = fixture(async command => ({ Item: command instanceof GetCommand
      && command.input.Key?.sk === "VERIFIED"
      ? { pk: `LEAD#${leadId}`, sk: "VERIFIED", status: "open", ...lead,
          canonicalUrl: "not-a-url" }
      : { pk, sk: `PROFILE#${artifactId}`, status: "verified", candidateId,
          artifactId, subjectId: "" } }));
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
    expect(items[3]?.Put?.Item?.sk).toBe(`RUN#${runId}`);
    expect(items[4]?.Put?.Item).toMatchObject({ pk, sk: `CONSENT#${runId}`,
      runId, state: "granted", scope: "apply-one-job", version: 1 });
    expect(await port.profileArtifactsAvailable(candidateId, artifactId)).toBe(true);
    expect(s3send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("requires every PDF referenced by the candidate's decrypted profile", async () => {
    const good = fixture(async () => ({}), { profile: profile({ transcriptId }) });
    expect(await good.port.profileArtifactsAvailable(candidateId, artifactId)).toBe(true);
    expect(good.vaultRead).toHaveBeenCalledTimes(3);
    const missing = fixture(async () => ({}), { profile: profile({ transcriptId }),
      missingKey: `candidates/${candidateId}/artifacts/${transcriptId}` });
    expect(await missing.port.profileArtifactsAvailable(candidateId, artifactId)).toBe(false);
    const wrongType = fixture(async () => ({}), { wrongContentTypeKey:
      `candidates/${candidateId}/artifacts/${resumeId}` });
    expect(await wrongType.port.profileArtifactsAvailable(candidateId, artifactId)).toBe(false);
    const badPdf = fixture(async () => ({}), { corruptPdfKey: resumeId });
    expect(await badPdf.port.profileArtifactsAvailable(candidateId, artifactId)).toBe(false);
  });

  it("rejects profile references outside the candidate or back to itself", async () => {
    const otherCandidate = fixture(async () => ({}), { profile: profile({ candidateId: leadId }) });
    expect(await otherCandidate.port.profileArtifactsAvailable(candidateId, artifactId)).toBe(false);
    const self = fixture(async () => ({}), { profile: profile({ resumeId: artifactId }) });
    expect(await self.port.profileArtifactsAvailable(candidateId, artifactId)).toBe(false);
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
