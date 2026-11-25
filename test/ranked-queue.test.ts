import { describe, expect, it } from "vitest";
import { reconcileReportedQueue } from "../src/application/queue-reconcile.js";
import { selectRankedJobs } from "../src/application/ranked-queue.js";
import { candidateProfileSchema, searchPreferencesSchema } from "../src/candidate/schema.js";
import type { DiscoveredJob, DiscoveryState } from "../src/types.js";

const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, Texas", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["US"], sponsorshipRequiredNowOrFuture: false },
  skills: { languages: ["TypeScript"] }, education: [], experience: [], projects: [],
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
  it("refreshes a pending job, ranks recent jobs first, and backfills when capacity remains", () => {
    const state: DiscoveryState = { jobs: {
      older: { firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), reportedAt: now.toISOString() },
    } };
    const selected = selectRankedJobs([job("older", 336), job("recent", 3), job("week", 168)],
      state, new Set(["older"]), candidate, preferences, 48, null, now);
    expect(selected.map(({ job: item }) => item.id)).toEqual(["recent", "week", "older"]);
    expect(selected.length).toBeGreaterThan(preferences.applicationPolicy.dailyHardCap);
    reconcileReportedQueue(state, new Set(["older"]), new Set(selected.map(({ job: item }) => item.id)));
    expect(state.jobs.older?.reportedAt).toBeDefined();

    const backfill = selectRankedJobs([job("older", 336), job("week", 168)],
      state, new Set(["older"]), candidate, preferences, 48, null, now);
    expect(backfill.map(({ job: item }) => item.id)).toEqual(["week", "older"]);
  });

  it("excludes already reported jobs outside the pending queue and applies the age limit", () => {
    const state: DiscoveryState = { jobs: {
      submitted: { firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), reportedAt: now.toISOString() },
    } };
    const selected = selectRankedJobs([job("submitted", 2), job("week", 168), job("recent", 4)],
      state, new Set(), candidate, preferences, 48, 120, now);
    expect(selected.map(({ job: item }) => item.id)).toEqual(["recent"]);
  });

  it("does not keep a previous job that vanished from the official source", () => {
    const state: DiscoveryState = { jobs: {
      closed: { firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), reportedAt: now.toISOString() },
    } };
    const selected = selectRankedJobs([job("recent", 4)], state, new Set(["closed"]),
      candidate, preferences, 48, null, now);
    expect(selected.map(({ job: item }) => item.id)).toEqual(["recent"]);
    reconcileReportedQueue(state, new Set(["closed"]), new Set(["recent"]));
    expect(state.jobs.closed?.reportedAt).toBeUndefined();
  });
});
