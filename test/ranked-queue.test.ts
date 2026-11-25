import { describe, expect, it } from "vitest";
import { reconcileReportedQueue, retainUnavailableJobs, runnableJobs } from "../src/application/queue-reconcile.js";
import { queueFileSchema } from "../src/application/queue-schema.js";
import { selectRankedJobs } from "../src/application/ranked-queue.js";
import { candidateProfileSchema, searchPreferencesSchema } from "../src/candidate/schema.js";
import type { DiscoveredJob, DiscoveryState } from "../src/types.js";

const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, Texas", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["US"], sponsorshipRequiredNowOrFuture: false },
  skills: { languages: ["TypeScript"] }, education: [], experience: [{
    employer: "Example", title: "Engineer", employmentType: "Intern", start: "2025", end: "2025",
    claims: [{ id: "verified-typescript", claim: "Built TypeScript services", skills: ["TypeScript"],
      evidence: [{ source: "user-confirmed", uri: "private:work-history" }],
      status: "user-confirmed", allowedUses: ["matching", "resume"] }],
  }], projects: [],
});
const preferences = searchPreferencesSchema.parse({
  version: 1, targetRoles: ["Software Engineer"],
  workArrangements: { preferred: ["Remote"], accepted: ["Hybrid"] },
  compensation: { preferredBaseFloor: 100_000 },
  applicationPolicy: { dailyTarget: 2, dailyHardCap: 2, requireFinalApproval: false },
});
const now = new Date("2026-11-25T16:00:00Z");
function job(id: string, hoursOld: number, descriptionText = "TypeScript"): DiscoveredJob {
  const date = new Date(now.getTime() - hoursOld * 3_600_000).toISOString();
  return { id, provider: "greenhouse", company: "Example", title: "Software Engineer",
    location: "Remote - US", department: "Engineering", employmentType: "Full time",
    workplaceType: "Remote", compensation: "$100,000-$140,000", descriptionText,
    applicationUrl: `https://example.com/jobs/${id}`, sourceUrl: `https://example.com/jobs/${id}`,
    sourcePublishedAt: date, sourceUpdatedAt: null, firstSeenAt: date,
    discoveredAt: now.toISOString(), isNew: false, isFresh: hoursOld <= 48,
    freshnessBasis: "source-published", matchedKeywords: [] };
}

describe("daily ranked queue", () => {
  it("fails closed for queue entries written before source verification was recorded", () => {
    const legacy = queueFileSchema.parse({ queue: [{ job: job("legacy", 3) }] });
    expect(legacy.queue[0]?.sourceVerification).toBe("unavailable");
    expect(runnableJobs(legacy.queue)).toEqual([]);
  });

  it("retains a pending job during its source outage but bars it from execution", () => {
    const pending = job("pending", 72);
    const verified = job("verified", 2);
    const failures = [{ source: { provider: "greenhouse" as const, company: "Example",
      boardToken: "example", enabled: true, allowedApplicationHosts: [] }, message: "HTTP 503" }];
    const retained = retainUnavailableJobs([{ job: pending, sourceVerification: "verified" }], failures);
    expect(retained).toEqual([{ job: pending, sourceVerification: "unavailable" }]);
    expect(runnableJobs([{ job: verified, sourceVerification: "verified" }, ...retained]))
      .toEqual([verified]);

    const state: DiscoveryState = { jobs: { pending: {
      firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), reportedAt: now.toISOString(),
    } } };
    reconcileReportedQueue(state, new Set([pending.id]), new Set(retained.map(({ job: item }) => item.id)));
    expect(state.jobs.pending?.reportedAt).toBeDefined();
  });

  it("drops an absent job after a successful source fetch", () => {
    const previous = [{ job: job("closed", 72), sourceVerification: "unavailable" as const }];
    expect(retainUnavailableJobs(previous, [])).toEqual([]);
    expect(retainUnavailableJobs(previous, [{ source: { provider: "ashby", company: "Example",
      boardName: "example", enabled: true, allowedApplicationHosts: [] }, message: "HTTP 503" }]))
      .toEqual([]);
  });

  it("refreshes a pending job, ranks recent jobs first, and backfills when capacity remains", () => {
    const state: DiscoveryState = { jobs: {
      older: { firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), reportedAt: now.toISOString() },
    } };
    const selected = selectRankedJobs([job("older", 336), job("recent", 3), job("week", 168)],
      candidate, preferences, 48, null, now);
    expect(selected.map(({ job: item }) => item.id)).toEqual(["recent", "week", "older"]);
    expect(selected.length).toBeGreaterThan(preferences.applicationPolicy.dailyHardCap);
    reconcileReportedQueue(state, new Set(["older"]), new Set(selected.map(({ job: item }) => item.id)));
    expect(state.jobs.older?.reportedAt).toBeDefined();

    const backfill = selectRankedJobs([job("older", 336), job("week", 168)],
      candidate, preferences, 48, null, now);
    expect(backfill.map(({ job: item }) => item.id)).toEqual(["week", "older"]);
  });

  it("recovers reported jobs after queue loss and still applies the age limit", () => {
    const selected = selectRankedJobs([job("submitted", 2), job("week", 168), job("recent", 4)],
      candidate, preferences, 48, 120, now);
    expect(selected.map(({ job: item }) => item.id)).toEqual(["submitted", "recent"]);
  });

  it("does not keep a previous job that vanished from the official source", () => {
    const state: DiscoveryState = { jobs: {
      closed: { firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), reportedAt: now.toISOString() },
    } };
    const selected = selectRankedJobs([job("recent", 4)], candidate, preferences, 48, null, now);
    expect(selected.map(({ job: item }) => item.id)).toEqual(["recent"]);
    reconcileReportedQueue(state, new Set(["closed"]), new Set(["recent"]));
    expect(state.jobs.closed?.reportedAt).toBeUndefined();
  });
});
