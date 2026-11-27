import { describe, expect, it, vi } from "vitest";
import { verifiedOfficialLead, type OfficialLeadRow } from "../src/cloud/official-lead-sync.js";
import { handleJobDiscoveryHttp, matchedOfficialJobs } from "../src/hosted/job-discovery.js";

const now = new Date("2026-11-27T12:00:00.000Z");
const candidateId = "91216845-7f44-5bd6-8357-885548676078";
const profile = () => Buffer.from(JSON.stringify({ version: 1,
  provenance: "candidate-entered-and-reviewed", candidateId,
  targetRoles: ["Software Engineer"], locations: ["Remote"],
  consent: { reviewed: true, storage: true, automation: true } }));
function lead(number: number, changes: Record<string, unknown> = {}): OfficialLeadRow {
  return verifiedOfficialLead({ provider: "greenhouse", boardToken: "acme", company: "Acme" }, {
    provider: "greenhouse", id: `greenhouse:acme:${number}`,
    applicationUrl: `https://job-boards.greenhouse.io/acme/jobs/${number}`,
    title: "Software Engineer", company: "Acme", descriptionText: "Build software.",
    location: "Remote", department: null, employmentType: null, workplaceType: null,
    compensation: null, sourceUrl: "https://boards-api.greenhouse.io", sourcePublishedAt: null,
    sourceUpdatedAt: null, ...changes,
  }, now);
}

describe("job seeker discovery", () => {
  it("filters stale, closed, wrong-role, and wrong-location postings", () => {
    const valid = lead(100);
    const stale = { ...lead(101), expiresAt: Math.floor(now.getTime() / 1000) };
    const malformedTtl = { ...lead(105), expiresAt: undefined } as unknown as OfficialLeadRow;
    const closed = { ...lead(102), status: "closed" } as unknown as OfficialLeadRow;
    const otherRole = lead(103, { title: "Account Executive" });
    const otherPlace = lead(104, { location: "New York" });
    const result = matchedOfficialJobs([valid, stale, closed, otherRole, otherPlace, malformedTtl],
      profile(), candidateId, now);
    expect(result.jobs.map(job => job.leadId)).toEqual([valid.leadId]);
    expect(result.jobs[0]?.officialUrl).toBe(valid.canonicalUrl);
    expect(result.jobs[0]).not.toHaveProperty("descriptionText");
  });

  it("keeps the exact official apply link while checking its base posting identity", () => {
    const exactApply = { ...lead(106),
      canonicalUrl: "https://job-boards.greenhouse.io/acme/jobs/106/apply" };
    const result = matchedOfficialJobs([exactApply], profile(), candidateId, now);
    expect(result.jobs[0]?.officialUrl).toBe(exactApply.canonicalUrl);
  });

  it("bounds pages to ten and refuses a profile for another tenant", () => {
    const leads = Array.from({ length: 12 }, (_, i) => lead(i + 100));
    expect(matchedOfficialJobs(leads, profile(), candidateId, now, 0)).toMatchObject({
      jobs: expect.any(Array), nextPage: 1 });
    expect(matchedOfficialJobs(leads, profile(), candidateId, now, 0).jobs).toHaveLength(10);
    expect(matchedOfficialJobs(leads, profile(), candidateId, now, 1).jobs).toHaveLength(2);
    expect(() => matchedOfficialJobs(leads, profile(), "e6846107-caf1-54e2-9e46-a7d535623fd2", now))
      .toThrow("Profile identity mismatch");
  });

  it("keeps page order stable when publication timestamps are mixed or missing", () => {
    const first = lead(201);
    const older = { ...lead(202), verifiedAtEpoch: now.getTime() - 2000 };
    const published = { ...lead(203), provenance: { ...lead(203).provenance,
      sourcePublishedAt: new Date(now.getTime() - 1000).toISOString() } };
    const order = matchedOfficialJobs([older, published, first], profile(), candidateId, now)
      .jobs.map(job => job.leadId);
    expect(order).toEqual([first.leadId, published.leadId, older.leadId]);
    expect(matchedOfficialJobs([published, first, older], profile(), candidateId, now)
      .jobs.map(job => job.leadId)).toEqual(order);
  });

  it("derives tenant identity from a verified token and rejects caller-selected IDs", async () => {
    const loadReviewedProfile = vi.fn(async () => profile());
    const loadOfficialLeads = vi.fn(async () => [lead(100)]);
    const deps = { appOrigin: "https://staging.openapplyagent.xyz", issuer: "https://issuer.example",
      verifySubject: vi.fn(async () => "job-seeker-1"), candidateIdForSubject: vi.fn(() => candidateId),
      ports: { loadReviewedProfile, loadOfficialLeads }, now: () => now };
    const request = (path: string, token = "a.b.c") => new Request(`https://staging.openapplyagent.xyz${path}`, {
      headers: { origin: deps.appOrigin, authorization: `Bearer ${token}` },
    });
    const valid = await handleJobDiscoveryHttp(request("/api/jobs/matches?page=0"), deps);
    expect(valid.status).toBe(200);
    expect(loadReviewedProfile).toHaveBeenCalledWith(candidateId, "job-seeker-1");
    expect(deps.candidateIdForSubject).toHaveBeenCalledWith(deps.issuer, "job-seeker-1");
    expect((await handleJobDiscoveryHttp(request("/api/jobs/matches?leadId=123"), deps)).status).toBe(400);
    expect((await handleJobDiscoveryHttp(request("/api/jobs/matches?page=99"), deps)).status).toBe(400);
    deps.verifySubject.mockRejectedValueOnce(new Error("bad signature"));
    expect((await handleJobDiscoveryHttp(request("/api/jobs/matches"), deps)).status).toBe(401);
    expect(loadOfficialLeads).toHaveBeenCalledTimes(1);
  });
});
