import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { DynamoOfficialLeadStore, officialLeadSyncConfigSchema, officialSourceRequest,
  syncOfficialLeads, verifiedOfficialLead, type LeadMember,
  type OfficialLeadSource, type OfficialLeadStore } from "../src/cloud/official-lead-sync.js";
import type { NormalizedJob } from "../src/types.js";

const now = new Date("2026-11-27T02:00:00.000Z");
const greenhouse: OfficialLeadSource = { provider: "greenhouse", boardToken: "acme", company: "Acme Inc" };
const ashby: OfficialLeadSource = { provider: "ashby", boardName: "acme", company: "Acme Inc" };
const lever: OfficialLeadSource = { provider: "lever", site: "acme", region: "eu", company: "Acme Inc" };
const smart: OfficialLeadSource = { provider: "smartrecruiters", companyIdentifier: "Acme", company: "Acme Inc" };

function posting(provider: NormalizedJob["provider"], id: string, applicationUrl: string): NormalizedJob {
  return { provider, id, applicationUrl, company: "Acme Inc", title: "Software Engineer",
    descriptionText: "Build production software.", location: "Remote", department: null,
    employmentType: null, workplaceType: null, compensation: null,
    sourceUrl: applicationUrl, sourcePublishedAt: null, sourceUpdatedAt: null };
}
const gh = () => posting("greenhouse", "greenhouse:acme:1234", "https://job-boards.greenhouse.io/acme/jobs/1234?ref=test");

describe("verified official hosted leads", () => {
  it("accepts only an exact posting from each configured official ATS", () => {
    const examples: [OfficialLeadSource, NormalizedJob][] = [
      [greenhouse, gh()],
      [ashby, posting("ashby", "ashby:acme:abc-123", "https://jobs.ashbyhq.com/acme/abc-123/application")],
      [lever, posting("lever", "lever:acme:abc-123", "https://jobs.eu.lever.co/acme/abc-123/apply")],
      [smart, posting("smartrecruiters", "smartrecruiters:Acme:744000138717897",
        "https://jobs.smartrecruiters.com/Acme/744000138717897-software-engineer")],
    ];
    for (const [source, job] of examples) {
      const row = verifiedOfficialLead(source, job, now);
      expect(row.pk).toBe(`LEAD#${row.leadId}`);
      expect(row.sk).toBe("VERIFIED");
      expect(row.status).toBe("open");
      expect(row.jobKey).toBe(officialJobKey(row.job));
      expect(row.expiresAt).toBe(Math.floor(now.getTime() / 1000) + 900);
      expect(row.canonicalUrl).not.toContain("ref=test");
      expect(row.provenance.kind).toBe("official-ats-api");
    }
  });

  it("rejects stale identity, reassigned requisitions, and off-provider apply URLs", () => {
    expect(() => verifiedOfficialLead(greenhouse, { ...gh(), id: "greenhouse:other:1234" }, now)).toThrow();
    expect(() => verifiedOfficialLead(greenhouse, { ...gh(), applicationUrl: "https://job-boards.greenhouse.io/acme/jobs/5678" }, now)).toThrow();
    expect(() => verifiedOfficialLead(greenhouse, { ...gh(), applicationUrl: "https://job-boards.greenhouse.io/other/jobs/1234" }, now)).toThrow();
    expect(() => verifiedOfficialLead(greenhouse, { ...gh(), applicationUrl: "https://127.0.0.1/acme/jobs/1234" }, now)).toThrow();
    expect(() => verifiedOfficialLead(greenhouse, { ...gh(), descriptionText: "" }, now)).toThrow();
    expect(() => verifiedOfficialLead(lever, posting("lever", "lever:acme:abc-123", "https://jobs.lever.co/acme/abc-123"), now)).toThrow();
  });

  it("uses stable job identity and separates cross-provider collisions", () => {
    const first = verifiedOfficialLead(greenhouse, gh(), now);
    const same = verifiedOfficialLead({ ...greenhouse, company: "Different public name" },
      { ...gh(), company: "Different public name" }, new Date(now.getTime() + 1000));
    const other = verifiedOfficialLead(ashby,
      posting("ashby", "ashby:acme:1234", "https://jobs.ashbyhq.com/acme/1234"), now);
    expect(first.leadId).toBe(same.leadId);
    expect(first.jobKey).toBe(same.jobKey);
    expect(first.leadId).not.toBe(other.leadId);
    expect(first.sourceKey).not.toBe(other.sourceKey);
  });
});

describe("bounded official feed requests", () => {
  it("refuses arbitrary source URLs before contacting the network", async () => {
    const network = vi.fn<typeof fetch>();
    const request = officialSourceRequest(greenhouse, network);
    await expect(request("http://boards-api.greenhouse.io/v1/boards/acme/jobs")).rejects.toThrow();
    await expect(request("https://127.0.0.1/private")).rejects.toThrow();
    await expect(request("https://boards-api.greenhouse.io.evil.test/jobs")).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    expect(() => officialLeadSyncConfigSchema.parse({ version: 1,
      sources: [{ provider: "jsonld", url: "http://127.0.0.1", company: "X" }] })).toThrow();
    expect(() => officialLeadSyncConfigSchema.parse({ version: 1,
      sources: [{ ...greenhouse, url: "https://evil.test" }] })).toThrow();
  });

  it("rejects redirect and oversized source responses", async () => {
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    await expect(officialSourceRequest(greenhouse, redirect)("https://boards-api.greenhouse.io/v1/boards/acme/jobs"))
      .rejects.toThrow("redirected");
    expect(redirect.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response("too large", {
      headers: { "content-length": String(9 * 1024 * 1024) } }));
    await expect(officialSourceRequest(greenhouse, oversized)("https://boards-api.greenhouse.io/v1/boards/acme/jobs"))
      .rejects.toThrow("size limit");
  });
});

describe("official lead reconciliation", () => {
  function store() {
    const rows = new Map<string, ReturnType<typeof verifiedOfficialLead>>();
    const members = new Map<string, LeadMember>();
    const api: OfficialLeadStore = {
      async upsert(row) { rows.set(row.leadId, row); members.set(row.leadId,
        { pk: row.sourceKey, sk: `LEAD#${row.leadId}`, leadId: row.leadId,
          jobKey: row.jobKey, verifiedAtEpoch: row.verifiedAtEpoch }); },
      async members(_source, max) {
        if (members.size > max) throw new Error("Official source membership exceeded bound");
        return [...members.values()];
      },
      async closeMissing(member) { rows.delete(member.leadId); members.delete(member.leadId); },
    };
    return { rows, members, api };
  }
  const config = { version: 1, sources: [greenhouse], maxJobsPerSource: 2 };
  it("populates then closes disappeared postings after a complete refresh", async () => {
    const saved = store();
    const first = await syncOfficialLeads(config, saved.api, { now,
      fetchJobs: async () => [gh()] });
    expect(first).toEqual([{ provider: "greenhouse", accepted: 1, closed: 0, failed: false }]);
    expect(saved.rows.size).toBe(1);
    const second = await syncOfficialLeads(config, saved.api, { now: new Date(now.getTime() + 1000),
      fetchJobs: async () => [] });
    expect(second).toEqual([{ provider: "greenhouse", accepted: 0, closed: 1, failed: false }]);
    expect(saved.rows.size).toBe(0);
  });
  it("replaces a posting when the source is already at full capacity", async () => {
    const saved = store();
    const second = { ...gh(), id: "greenhouse:acme:5678",
      applicationUrl: "https://job-boards.greenhouse.io/acme/jobs/5678" };
    const replacement = { ...gh(), id: "greenhouse:acme:91011",
      applicationUrl: "https://job-boards.greenhouse.io/acme/jobs/91011" };
    await syncOfficialLeads(config, saved.api, { now, fetchJobs: async () => [gh(), second] });
    expect(saved.rows.size).toBe(2);
    const result = await syncOfficialLeads(config, saved.api, {
      now: new Date(now.getTime() + 1000), fetchJobs: async () => [gh(), replacement],
    });
    expect(result).toEqual([{ provider: "greenhouse", accepted: 2, closed: 1, failed: false }]);
    expect(saved.rows.size).toBe(2);
    expect(saved.rows.has(verifiedOfficialLead(greenhouse, second, now).leadId)).toBe(false);
    expect(saved.rows.has(verifiedOfficialLead(greenhouse, replacement, now).leadId)).toBe(true);
  });
  it("parses a provider API response through the guarded request path", async () => {
    const saved = store();
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ jobs: [{
      id: 1234, title: "Software Engineer", absolute_url: gh().applicationUrl,
      content: "<p>Build production software.</p>",
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await syncOfficialLeads(config, saved.api, { now, network });
    expect(result).toEqual([{ provider: "greenhouse", accepted: 1, closed: 0, failed: false }]);
    expect(saved.rows.size).toBe(1);
    expect(network.mock.calls[0]?.[0]).toEqual(new URL("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"));
    expect(network.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
  it("keeps prior rows on failed, truncated, duplicate, or reassigned source refresh", async () => {
    const saved = store();
    await syncOfficialLeads(config, saved.api, { now, fetchJobs: async () => [gh()] });
    const failures = [
      async () => { throw new Error("HTTP 503"); },
      async () => [gh(), { ...gh(), id: "greenhouse:acme:5678",
        applicationUrl: "https://job-boards.greenhouse.io/acme/jobs/5678" },
        { ...gh(), id: "greenhouse:acme:91011",
          applicationUrl: "https://job-boards.greenhouse.io/acme/jobs/91011" }],
      async () => [gh(), gh()],
      async () => [{ ...gh(), applicationUrl: "https://job-boards.greenhouse.io/acme/jobs/5678" }],
    ];
    for (const fetchJobs of failures) {
      const result = await syncOfficialLeads(config, saved.api, { now, fetchJobs });
      expect(result[0]?.failed).toBe(true);
      expect(saved.rows.has(verifiedOfficialLead(greenhouse, gh(), now).leadId)).toBe(true);
    }
  });
  it("writes identity fences in a transactional DynamoDB upsert", async () => {
    const commands: unknown[] = [];
    const db = { send: vi.fn(async (command: unknown) => { commands.push(command); return {}; }) };
    const row = verifiedOfficialLead(greenhouse, gh(), now);
    await new DynamoOfficialLeadStore(db as never, "ledger").upsert(row);
    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    const items = (commands[0] as TransactWriteCommand).input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items[0]?.Put?.ConditionExpression).toContain("jobKey = :job");
    expect(items[0]?.Put?.ConditionExpression).toContain("sourceKey = :source");
    expect(items[0]?.Put?.ConditionExpression).toContain("verifiedAtEpoch <= :time");
    expect(items[1]?.Put?.Item?.pk).toBe(row.sourceKey);
  });
  it("does not reopen a closed posting from older or equal-time in-flight refreshes", async () => {
    const t0 = verifiedOfficialLead(greenhouse, gh(), now);
    const t1 = verifiedOfficialLead(greenhouse, gh(), new Date(now.getTime() + 1000));
    const t2 = verifiedOfficialLead(greenhouse, gh(), new Date(now.getTime() + 2000));
    const t3 = verifiedOfficialLead(greenhouse, gh(), new Date(now.getTime() + 3000));
    let lead: Record<string, unknown> | undefined;
    let memberExists = false;
    const db = { send: vi.fn(async (command: unknown): Promise<{ Item?: Record<string, unknown> }> => {
      if (command instanceof GetCommand) return lead ? { Item: lead } : {};
      if (!(command instanceof TransactWriteCommand)) throw new Error("Unexpected DynamoDB command");
      const items = command.input.TransactItems ?? [];
      const put = items[0]?.Put;
      if (put) {
        // Interpret the relevant DynamoDB condition for the simulated arrival order.
        expect(put.ConditionExpression).toContain("verifiedAtEpoch <= :time");
        expect(put.ConditionExpression).toContain("closedAtEpoch < :time");
        const incoming = put.Item as Record<string, unknown>;
        const incomingTime = incoming.verifiedAtEpoch as number;
        if (lead && (lead.jobKey !== incoming.jobKey || lead.sourceKey !== incoming.sourceKey
          || (lead.verifiedAtEpoch as number) > incomingTime
          || (typeof lead.closedAtEpoch === "number" && lead.closedAtEpoch >= incomingTime))) {
          throw new Error("ConditionalCheckFailedException");
        }
        lead = { ...incoming };
        memberExists = true;
        return {};
      }
      const update = items[0]?.Update;
      if (!update) throw new Error("Unexpected transaction");
      expect(update.UpdateExpression).toContain("verifiedAtEpoch = :time");
      expect(update.UpdateExpression).toContain("closedAtEpoch = :time");
      const time = update.ExpressionAttributeValues?.[":time"] as number;
      if (!lead || (lead.verifiedAtEpoch as number) >= time || !memberExists) {
        throw new Error("ConditionalCheckFailedException");
      }
      lead = { ...lead, status: "closed", expiresAt: update.ExpressionAttributeValues?.[":expires"],
        verifiedAtEpoch: time, closedAtEpoch: time };
      memberExists = false;
      return {};
    }) };
    const store = new DynamoOfficialLeadStore(db as never, "ledger");
    await store.upsert(t0);
    const originalMember: LeadMember = { pk: t0.sourceKey, sk: `LEAD#${t0.leadId}`,
      leadId: t0.leadId, jobKey: t0.jobKey, verifiedAtEpoch: t0.verifiedAtEpoch };
    // T1 is in flight; T2 first observes the posting missing and closes it.
    await store.closeMissing(originalMember, t2.verifiedAtEpoch, t2.expiresAt - 900);
    expect(lead?.status).toBe("closed");
    await expect(store.upsert(t1)).rejects.toThrow("ConditionalCheckFailedException");
    await expect(store.upsert(t2)).rejects.toThrow("ConditionalCheckFailedException");
    expect(lead?.status).toBe("closed");
    await store.upsert(t3);
    expect(lead?.status).toBe("open");
    expect(lead?.verifiedAtEpoch).toBe(t3.verifiedAtEpoch);
  });
});
