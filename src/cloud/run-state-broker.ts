import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { DynamoApplicationDispatchStore } from "./aws-durable-dispatch.js";
import { verifyArtifactRunCapability } from "./artifact-credential-broker.js";
import { DurableApplicationJournal, officialJobKey } from "./durable-journal.js";
import { requireHostedAccess } from "../hosted/entitlement.js";
import { verifyTaskTimeOfficialLead, type OfficialPostingFetcher }
  from "./task-time-official-lead.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const job = z.strictObject({ provider: z.string().trim().min(1).max(200),
  employerId: z.string().trim().min(1).max(200), requisitionId: z.string().trim().min(1).max(200) });
const syntheticJob = z.strictObject({ provider: z.literal("synthetic"),
  employerId: z.literal("fixture"), requisitionId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) });
const previewLead = z.object({ pk: z.string(), sk: z.literal("VERIFIED"), status: z.literal("open"),
  leadId: uuid, job, jobKey: z.string().regex(/^JOB#[a-f0-9]{64}$/),
  canonicalUrl: z.url(), expiresAt: z.number().int().positive(),
  sourceKey: z.string().regex(/^SOURCE#[a-f0-9]{64}$/),
  verifiedAt: z.string().datetime(), verifiedAtEpoch: z.number().int().nonnegative(),
  provenance: z.object({ kind: z.literal("official-ats-api"),
    provider: z.enum(["greenhouse", "ashby", "lever", "smartrecruiters"]),
    sourceUrl: z.url(), title: z.string().min(1).max(300),
    company: z.string().min(1).max(300), location: z.string().nullable().default(null),
    descriptionText: z.string().min(1).max(100_000),
    sourcePublishedAt: z.string().nullable() }) });
const previewProfile = z.object({ pk: z.string(), sk: z.string(),
  status: z.literal("verified"), candidateId: uuid, artifactId: uuid,
  subjectId: z.string().min(1).max(160), applicationProfileReady: z.literal(true) });

function leadFingerprint(value: z.output<typeof previewLead>): string {
  const p = value.provenance;
  return createHash("sha256").update(JSON.stringify([
    value.pk, value.sk, value.status, value.leadId,
    value.job.provider, value.job.employerId, value.job.requisitionId,
    value.jobKey, value.canonicalUrl, value.expiresAt, value.sourceKey,
    value.verifiedAt, value.verifiedAtEpoch,
    p.kind, p.provider, p.sourceUrl, p.title, p.company, p.location,
    p.descriptionText, p.sourcePublishedAt,
  ])).digest("hex");
}
const request = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("ownsRun") }),
  z.strictObject({ operation: z.literal("hasCurrentConsent") }),
  z.strictObject({ operation: z.literal("loadIdentity") }),
  z.strictObject({ operation: z.literal("loadProfileArtifactId") }),
  z.strictObject({ operation: z.literal("loadPreviewBinding"), leaseToken: uuid }),
  z.strictObject({ operation: z.literal("loadEntitlements"), subjectId: z.string().trim().min(1).max(128) }),
  z.strictObject({ operation: z.literal("acquireLease") }),
  z.strictObject({ operation: z.literal("renewLease"), leaseToken: uuid }),
  z.strictObject({ operation: z.literal("releaseLease"), leaseToken: uuid }),
  z.strictObject({ operation: z.literal("readSubmission"), job }),
  z.strictObject({ operation: z.literal("beginSubmission"), leaseToken: uuid,
    consentVersion: z.number().int().positive(), job }),
  z.strictObject({ operation: z.literal("markUncertain"), leaseToken: uuid, job }),
  z.strictObject({ operation: z.literal("confirmAfterVerification"), leaseToken: uuid, job,
    receipt: z.strictObject({ artifactId: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) }) }),
  z.strictObject({ operation: z.literal("recordSyntheticFinalClick"), leaseToken: uuid,
    job: syntheticJob }),
  z.strictObject({ operation: z.literal("readSyntheticClickAttempts"), job: syntheticJob }),
  z.strictObject({ operation: z.literal("readDispatch") }),
  z.strictObject({ operation: z.literal("markDispatchCompleted") }),
]);
export type RunStateRequest = z.infer<typeof request>;

/** The browser role cannot access DynamoDB. Every permitted mutation is an
 * existing journal method, and the broker derives candidate/run from a signed
 * launch capability rather than accepting a caller-supplied partition key. */
export async function executeRunStateRequest(input: unknown, capability: string,
  secret: Uint8Array, nowEpoch: number, db: DynamoDBDocumentClient,
  config: { ledgerTable: string; entitlementTable: string },
  previewDependencies: { fetchPostings?: OfficialPostingFetcher; clock?: () => number } = {}): Promise<unknown> {
  const command = request.parse(input);
  const scope = verifyArtifactRunCapability(capability, secret, nowEpoch);
  const pk = `CANDIDATE#${scope.candidateId}`;
  const [task, deleted] = await Promise.all([
    db.send(new GetCommand({ TableName: config.ledgerTable,
      Key: { pk, sk: `TASK#${scope.runId}` }, ConsistentRead: true })),
    db.send(new GetCommand({ TableName: config.ledgerTable,
      Key: { pk, sk: "DELETED" }, ConsistentRead: true })),
  ]);
  if (deleted.Item || task.Item?.capability !== capability
    || task.Item?.candidateId !== scope.candidateId || task.Item?.runId !== scope.runId
    || (task.Item?.state !== "reserved" && task.Item?.state !== "started")) {
    throw new Error("Run state access unavailable");
  }
  const admission = new DynamoHostedRunAdmission(db, config.ledgerTable);
  const journal = new DurableApplicationJournal(db, config.ledgerTable);
  const dispatch = new DynamoApplicationDispatchStore(db, config.ledgerTable);
  const billing = new DynamoCandidatePlanStatus(db, config.entitlementTable);
  const run = await admission.loadIdentity(scope.candidateId, scope.runId);
  if ("job" in command && officialJobKey(command.job) !== officialJobKey(run.job)) {
    throw new Error("Run job scope mismatch");
  }
  switch (command.operation) {
    case "ownsRun": return true;
    case "hasCurrentConsent": return admission.hasCurrentConsent(scope.candidateId, scope.runId);
    case "loadIdentity": return run;
    case "loadProfileArtifactId": return admission.loadProfileArtifactId(scope.candidateId, scope.runId);
    case "loadPreviewBinding": {
      const binding = await admission.loadPreviewRun(scope.candidateId, scope.runId);
      const eligible = () => admission.hasArtifactGrantEligibility(scope.candidateId, scope.runId,
        command.leaseToken, Math.floor((previewDependencies.clock?.() ?? Date.now()) / 1000));
      if (!await eligible()) throw new Error("Preview run lease unavailable");
      if ((await journal.readSubmission(scope.candidateId, binding.job)).status !== "not_started") {
        throw new Error("Preview run has a submission intent");
      }
      requireHostedAccess(binding.subjectId, await billing.loadEntitlements(binding.subjectId));
      const leadKey = { pk: `LEAD#${binding.leadId}`, sk: "VERIFIED" };
      const profileKey = { pk: `CANDIDATE#${scope.candidateId}`,
        sk: `PROFILE#${binding.profileArtifactId}` };
      const readInputs = async () => {
        const [leadResult, profileResult] = await Promise.all([
          db.send(new GetCommand({ TableName: config.ledgerTable,
            Key: leadKey, ConsistentRead: true })),
          db.send(new GetCommand({ TableName: config.ledgerTable,
            Key: profileKey, ConsistentRead: true })),
        ]);
        const lead = previewLead.parse(leadResult.Item);
        const profile = previewProfile.parse(profileResult.Item);
        if (lead.pk !== leadKey.pk || lead.leadId !== binding.leadId
          || lead.jobKey !== binding.jobKey || officialJobKey(lead.job) !== binding.jobKey
          || profile.pk !== profileKey.pk || profile.sk !== profileKey.sk
          || profile.candidateId !== scope.candidateId
          || profile.artifactId !== binding.profileArtifactId
          || profile.subjectId !== binding.subjectId) {
          throw new Error("Preview run inputs changed");
        }
        return lead;
      };
      const lead = await readInputs();
      const now = new Date(previewDependencies.clock?.() ?? Date.now());
      const current = await verifyTaskTimeOfficialLead(lead, binding.job, now,
        previewDependencies.fetchPostings);
      const finalEpoch = Math.floor((previewDependencies.clock?.() ?? Date.now()) / 1000);
      verifyArtifactRunCapability(capability, secret, finalEpoch);
      const latest = await readInputs();
      if (leadFingerprint(latest) !== leadFingerprint(lead)
        || latest.expiresAt <= finalEpoch || !await eligible()
        || (await journal.readSubmission(scope.candidateId, binding.job)).status !== "not_started") {
        throw new Error("Preview run changed during official revalidation");
      }
      requireHostedAccess(binding.subjectId,
        await billing.loadEntitlements(binding.subjectId), new Date(finalEpoch * 1000));
      return { lead: current, profileArtifactId: binding.profileArtifactId };
    }
    case "loadEntitlements":
      if (command.subjectId !== run.subjectId) throw new Error("Billing subject scope mismatch");
      return billing.loadEntitlements(run.subjectId);
    case "acquireLease": return journal.acquireLease(scope.candidateId, scope.runId);
    case "renewLease": return journal.renewLease(scope.candidateId, command.leaseToken);
    case "releaseLease":
      await journal.releaseLease(scope.candidateId, command.leaseToken); return null;
    case "readSubmission": return journal.readSubmission(scope.candidateId, command.job);
    case "beginSubmission":
      requireHostedAccess(run.subjectId, await billing.loadEntitlements(run.subjectId));
      return journal.beginSubmission(scope.candidateId, command.leaseToken,
        scope.runId, command.consentVersion, command.job);
    case "markUncertain":
      await journal.markUncertain(scope.candidateId, command.leaseToken, command.job); return null;
    case "confirmAfterVerification": return journal.confirmAfterVerification(scope.candidateId,
      command.leaseToken, command.job, command.receipt);
    case "recordSyntheticFinalClick":
      requireHostedAccess(run.subjectId, await billing.loadEntitlements(run.subjectId));
      return journal.recordSyntheticFinalClick(scope.candidateId, command.leaseToken,
        scope.runId, run.consentVersion, command.job);
    case "readSyntheticClickAttempts":
      return journal.readSyntheticClickAttempts(scope.candidateId, command.job);
    case "readDispatch": {
      const row = await dispatch.read(scope.candidateId, scope.runId);
      if (!row || (row.state !== "queued" && row.state !== "launched")) {
        throw new Error("Exact dispatch is not ready");
      }
      return { body: row.body, state: row.state };
    }
    case "markDispatchCompleted": {
      const submitted = await journal.readSubmission(scope.candidateId, run.job);
      if (submitted.status !== "confirmed") throw new Error("Dispatch is not confirmed");
      await dispatch.markCompleted(scope.candidateId, scope.runId); return null;
    }
  }
}
