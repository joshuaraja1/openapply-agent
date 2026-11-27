import { describe, expect, it, vi } from "vitest";
import { verifiedOfficialLead } from "../src/cloud/official-lead-sync.js";
import { verifyTaskTimeOfficialLead } from "../src/cloud/task-time-official-lead.js";
import type { NormalizedJob } from "../src/types.js";

const first = new Date("2026-11-27T12:00:00Z");
const taskTime = new Date("2026-11-27T12:01:00Z");
const source = { provider: "greenhouse" as const, boardToken: "acme", company: "Acme" };
const posting: NormalizedJob = { id: "greenhouse:acme:123456", provider: "greenhouse",
  company: "Acme", title: "Backend Engineer", descriptionText: "Python services",
  applicationUrl: "https://boards.greenhouse.io/acme/jobs/123456/apply",
  sourceUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
  location: null, department: null, employmentType: null, workplaceType: null,
  compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null };
const lead = () => verifiedOfficialLead(source, posting, first);

describe("task-time official posting revalidation", () => {
  it("returns a newly verified exact posting", async () => {
    const fetcher = vi.fn(async () => [posting]);
    const cached = lead();
    const current = await verifyTaskTimeOfficialLead(cached, cached.job, taskTime, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(current.jobKey).toBe(cached.jobKey);
    expect(current.verifiedAt).toBe(taskTime.toISOString());
    expect(current.canonicalUrl).toBe(cached.canonicalUrl);
  });

  it("refuses a closed or changed posting", async () => {
    const cached = lead();
    await expect(verifyTaskTimeOfficialLead(cached, cached.job, taskTime,
      async () => [])).rejects.toThrow("closed");
    await expect(verifyTaskTimeOfficialLead(cached, cached.job, taskTime,
      async () => [{ ...posting, applicationUrl: "https://boards.greenhouse.io/acme/jobs/123456" }]))
      .rejects.toThrow("changed");
    await expect(verifyTaskTimeOfficialLead(cached, cached.job, taskTime,
      async () => [{ ...posting, descriptionText: "Different role" }]))
      .rejects.toThrow("changed");
  });

  it("rejects stale or cross-job cached metadata before a provider fetch", async () => {
    const cached = lead();
    const fetcher = vi.fn(async () => [posting]);
    await expect(verifyTaskTimeOfficialLead(cached, cached.job,
      new Date("2026-11-27T13:00:00Z"), fetcher)).rejects.toThrow("unavailable");
    await expect(verifyTaskTimeOfficialLead(cached, { ...cached.job, requisitionId: "999999" },
      taskTime, fetcher)).rejects.toThrow("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
