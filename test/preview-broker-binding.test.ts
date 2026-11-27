import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mintArtifactRunCapability } from "../src/cloud/artifact-credential-broker.js";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { verifiedOfficialLead } from "../src/cloud/official-lead-sync.js";
import { executeRunStateRequest } from "../src/cloud/run-state-broker.js";
import type { NormalizedJob } from "../src/types.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const profileArtifactId = "00000000-0000-4000-8000-000000000003";
const leaseToken = "00000000-0000-4000-8000-000000000004";
const otherRunId = "00000000-0000-4000-8000-000000000009";
const at = new Date("2026-11-27T12:00:00Z");
const taskTime = new Date("2026-11-27T12:01:00Z");
const epoch = Math.floor(taskTime.getTime() / 1000);
const secret = Buffer.alloc(32, 7);
const capability = mintArtifactRunCapability(candidateId, runId, secret, epoch);
const job = { provider: "greenhouse", employerId: "acme", requisitionId: "123456" };
const posting: NormalizedJob = { id: "greenhouse:acme:123456", provider: "greenhouse",
  company: "Acme", title: "Backend Engineer", descriptionText: "Python services",
  applicationUrl: "https://boards.greenhouse.io/acme/jobs/123456/apply",
  sourceUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
  location: null, department: null, employmentType: null, workplaceType: null,
  compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null };
const lead = verifiedOfficialLead({ provider: "greenhouse", boardToken: "acme",
  company: "Acme" }, posting, at);
const config = { ledgerTable: "openapply-staging-run-ledger", entitlementTable: "entitlements" };

function fixture(options: { deleted?: boolean; profileMissing?: boolean; leadClosed?: boolean;
  leadStale?: boolean; leadMutates?: boolean;
  leaseMissing?: boolean } = {}) {
  const seen: unknown[] = [];
  let leadReads = 0;
  const send = vi.fn(async (command: unknown) => {
    seen.push(command);
    if (command instanceof QueryCommand) return { Items: [{ pk: "SUBJECT#user-1",
      sk: "ENTITLEMENT#grant", record: { kind: "free-grant", subjectId: "user-1",
        grantId: "preview-fixture", approvedBy: "staging", startsAt: "2020-01-01T00:00:00Z",
        endsAt: "2099-01-01T00:00:00Z", revokedAt: null } }] };
    if (!(command instanceof GetCommand)) throw new Error("Unexpected write");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk === `LEAD#${lead.leadId}` && key.sk === "VERIFIED") {
      leadReads++;
      return { Item: options.leadClosed ? { ...lead, status: "closed" }
        : options.leadStale ? { ...lead, expiresAt: epoch - 1 }
          : options.leadMutates && leadReads > 1 ? { ...lead,
            provenance: { ...lead.provenance, descriptionText: "Changed after provider recheck" } }
            : lead };
    }
    if (key.pk !== `CANDIDATE#${candidateId}`) throw new Error("Cross-candidate read");
    if (key.sk === `TASK#${runId}`) return { Item: { pk: key.pk, sk: key.sk,
      candidateId, runId, capability, state: "started" } };
    if (key.sk === "DELETED") return { Item: options.deleted ? { pk: key.pk, sk: key.sk } : undefined };
    if (key.sk === `RUN#${runId}`) return { Item: { pk: key.pk, sk: key.sk,
      candidateId, runId, subjectId: "user-1", consentVersion: 1,
      profileArtifactId, leadId: lead.leadId, jobKey: officialJobKey(job), job } };
    if (key.sk === `CONSENT#${runId}`) return { Item: { pk: key.pk, sk: key.sk,
      runId, version: 1, state: "granted" } };
    if (key.sk === "LEASE") return { Item: options.leaseMissing ? undefined : {
      pk: key.pk, sk: key.sk, ownerToken: leaseToken, runId, expiresAt: epoch + 120 } };
    if (key.sk === officialJobKey(job)) return { Item: undefined };
    if (key.sk === `PROFILE#${profileArtifactId}`) return { Item: options.profileMissing
      ? undefined : { pk: key.pk, sk: key.sk, status: "verified", candidateId,
        artifactId: profileArtifactId, subjectId: "user-1", applicationProfileReady: true } };
    throw new Error(`Unexpected key ${key.sk}`);
  });
  return { seen, client: { send } as unknown as DynamoDBDocumentClient };
}

async function load(store: ReturnType<typeof fixture>, fetchPostings = vi.fn(async () => [posting])) {
  return executeRunStateRequest({ operation: "loadPreviewBinding", leaseToken }, capability,
    secret, epoch, store.client, config, { fetchPostings, clock: () => taskTime.getTime() });
}

describe("capability-scoped preview binding", () => {
  it("returns only the exact run's fresh lead and approved profile artifact ID", async () => {
    const store = fixture();
    const result = await load(store) as { lead: typeof lead; profileArtifactId: string };
    expect(result.profileArtifactId).toBe(profileArtifactId);
    expect(result.lead.canonicalUrl).toBe(lead.canonicalUrl);
    expect(result.lead.verifiedAt).toBe(taskTime.toISOString());
    expect(store.seen.some(item => item instanceof GetCommand
      && (item.input.Key as { pk: string }).pk === `LEAD#${lead.leadId}`)).toBe(true);
  });

  it("rejects a wrong run capability before reading the lead", async () => {
    const store = fixture();
    await expect(executeRunStateRequest({ operation: "loadPreviewBinding", leaseToken },
      mintArtifactRunCapability(candidateId, otherRunId, secret, epoch), secret, epoch,
      store.client, config, { fetchPostings: async () => [posting],
        clock: () => taskTime.getTime() })).rejects.toThrow();
    expect(store.seen.every(item => !(item instanceof GetCommand)
      || (item.input.Key as { pk: string }).pk !== `LEAD#${lead.leadId}`)).toBe(true);
  });

  it.each([
    { name: "expired lease", options: { leaseMissing: true } },
    { name: "closed lead", options: { leadClosed: true } },
    { name: "stale lead", options: { leadStale: true } },
    { name: "deleted profile", options: { profileMissing: true } },
    { name: "deleted candidate", options: { deleted: true } },
  ])("rejects $name before provider access", async ({ options }) => {
    const store = fixture(options);
    const fetchPostings = vi.fn(async () => [posting]);
    await expect(load(store, fetchPostings)).rejects.toThrow();
    expect(fetchPostings).not.toHaveBeenCalled();
  });

  it("rejects the official API's changed application URL", async () => {
    const store = fixture();
    await expect(load(store, vi.fn(async () => [{ ...posting,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/123456" }])))
      .rejects.toThrow("changed");
  });

  it("rejects a lead description changed between the two consistent reads", async () => {
    const store = fixture({ leadMutates: true });
    const fetchPostings = vi.fn(async () => [posting]);
    await expect(load(store, fetchPostings)).rejects.toThrow("changed during official revalidation");
    expect(fetchPostings).toHaveBeenCalledOnce();
  });
});
