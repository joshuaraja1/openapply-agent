import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
// @ts-expect-error Worker entrypoint is a standalone JavaScript module.
import worker from "../cloud/staging-login/worker.mjs";
import { handleApplicationRunHttp } from "../src/hosted/application-run-http.js";
import { handleApplicationEnqueueHttp } from "../src/hosted/application-enqueue-http.js";
import { candidateIdForSubject, type TrustedRunRecord } from "../src/cloud/hosted-run-creator.js";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { verifiedOfficialLead } from "../src/cloud/official-lead-sync.js";
import { approvedApplicationProfile, parseApprovedHostedProfile } from "../src/hosted/application-facts.js";
import { createJakeResumeSource } from "../src/resume/jake.js";
import type { DiscoveredJob, NormalizedJob } from "../src/types.js";

const appOrigin = "https://staging.example";
const apiOrigin = "https://billing.example";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
const subjectId = "job-seeker-1";
const candidateId = candidateIdForSubject(issuer, subjectId);
const profileArtifactId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000013";
const posting: NormalizedJob = {
  provider: "greenhouse", id: "greenhouse:example-employer:42",
  title: "Frontend Engineer", company: "Example Employer",
  descriptionText: "Build TypeScript applications for customers.",
  applicationUrl: "https://job-boards.greenhouse.io/example-employer/jobs/42",
  sourceUrl: "https://job-boards.greenhouse.io/example-employer/jobs/42",
  location: "Chicago", department: null, employmentType: null, workplaceType: null,
  compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null,
};
const lead = verifiedOfficialLead({ provider: "greenhouse", boardToken: "example-employer",
  company: "Example Employer" }, posting);
const leadId = lead.leadId;

function request(path: string, body: unknown, token = "a.b.c") {
  return new Request(`${appOrigin}${path}`, { method: "POST", headers: {
    origin: appOrigin, authorization: `Bearer ${token}`, "content-type": "application/json",
  }, body: JSON.stringify(body) });
}

describe("authenticated hosted application journey", () => {
  it("requires approved intake and paid access, then creates one run and one durable dispatch", async () => {
    const runs = new Map<string, TrustedRunRecord>();
    const consents = new Set<string>();
    const dispatches = new Map<string, { state: "pending_queue" | "queued" | "launched";
      body: string; groupId: string; deduplicationId: string }>();
    const queueSend = vi.fn(async () => {});
    const launch = vi.fn(async () => "started" as const);
    let approvedProfile = false;
    const applicationProfile = approvedApplicationProfile(profileArtifactId, {
      identity: { fullName: "Avery Example", location: "Chicago", email: "avery@example.test",
        phone: "555-0100" },
      authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
      skills: ["TypeScript"],
      education: [{ claim: "BS in Computer Science, Example University", skills: ["TypeScript"] }],
      experience: [{ employer: "Example Inc", title: "Software Engineering Intern",
        employmentType: "Internship", start: "May 2025", end: "August 2025",
        claims: [{ claim: "Built a TypeScript dashboard", skills: ["TypeScript"] }] }],
      projects: [{ name: "SQL search tool",
        claims: [{ claim: "Created a SQL search tool", skills: ["SQL"] }] }],
    });
    const profileBytes = Buffer.from(JSON.stringify({ version: 1, candidateId,
      provenance: "candidate-entered-and-reviewed", applicationProfile }));
    let committedLeadUrl: string | undefined;
    let paid = true;
    const billing = { loadEntitlements: async (_subject: string) => paid ? [{
      kind: "subscription", subjectId, subscriptionId: "sub_test_paid",
      status: "active", settledInvoiceId: "in_test_settled",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      paidThrough: new Date(Date.now() + 3_600_000).toISOString(),
    }] : [] };
    const verifySubject = async (token: string) => {
      if (token === "a.b.c") return subjectId;
      if (token === "x.y.z") return "other-job-seeker";
      throw new Error("Invalid token");
    };
    const runPorts = {
      billing,
      loadLead: async (id: string) => id === leadId ? lead : undefined,
      loadProfile: async (candidate: string, artifact: string) =>
        approvedProfile && candidate === candidateId && artifact === profileArtifactId
          ? (parseApprovedHostedProfile(profileBytes, candidate), {
            candidateId, artifactId: profileArtifactId, subjectId,
            applicationProfileReady: true as const }) : undefined,
      profileObjectExists: async (candidate: string, artifact: string) =>
        candidate === candidateId && artifact === profileArtifactId,
      createOrGet: async (record: TrustedRunRecord, verifiedLead: typeof lead) => {
        if (runs.has(record.runId)) return "existing" as const;
        committedLeadUrl = verifiedLead.canonicalUrl;
        runs.set(record.runId, record);
        consents.add(record.runId);
        return "created" as const;
      },
    };
    const enqueuePorts = {
      runRecords: { loadIdentity: async (candidate: string, run: string) => {
        const row = runs.get(run);
        if (!row || row.candidateId !== candidate) throw new Error("Run unavailable");
        return { subjectId: row.subjectId, consentVersion: row.consentVersion, job: row.job };
      } },
      authorization: {
        ownsRun: async (candidate: string, run: string) => runs.get(run)?.candidateId === candidate,
        hasCurrentConsent: async (_candidate: string, run: string) => consents.has(run),
      },
      billing,
      queue: { send: queueSend },
      dispatch: {
        ensurePending: async (_candidate: string, run: string,
          envelope: { body: string; groupId: string; deduplicationId: string }) => {
          const prior = dispatches.get(run);
          if (prior) return prior;
          const row = { state: "pending_queue" as const, ...envelope };
          dispatches.set(run, row);
          return row;
        },
        markQueued: async (_candidate: string, run: string) => {
          const row = dispatches.get(run)!;
          dispatches.set(run, { ...row, state: "queued" });
        },
        markLaunched: async (_candidate: string, run: string) => {
          const row = dispatches.get(run)!;
          dispatches.set(run, { ...row, state: "launched" });
        },
        markNeedsReconciliation: async () => {},
      },
      launcher: { launch },
    };
    const env = { AWS_API_ORIGIN: apiOrigin,
      APPLICATION_RUN_CREATION_ENABLED: "true", APPLICATION_ENQUEUE_ENABLED: "true" };
    vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => {
      const upstream = new Request(String(url), options);
      if (upstream.url.endsWith("/api/applications/runs")) {
        return handleApplicationRunHttp(upstream, { appOrigin, issuer, verifySubject, ports: runPorts });
      }
      if (upstream.url.endsWith("/api/applications/enqueue")) {
        return handleApplicationEnqueueHttp(upstream, { appOrigin, verifySubject, ports: enqueuePorts });
      }
      throw new Error("Unexpected upstream route");
    }));
    try {
      const body = { runId, leadId, profileArtifactId,
        consent: { granted: true, scope: "apply-one-job", policyVersion: "v1" } };
      const beforeReview = await worker.fetch(request("/api/applications/runs", body), env);
      expect(beforeReview.status).toBe(403);
      expect(runs.size).toBe(0);

      approvedProfile = true;
      const created = await worker.fetch(request("/api/applications/runs", body), env);
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ candidateId, runId });
      expect(runs.get(runId)).toMatchObject({ candidateId, subjectId, leadId,
        job: lead.job, jobKey: officialJobKey(lead.job), profileArtifactId });
      expect(committedLeadUrl).toBe(posting.applicationUrl);
      const template = await readFile("templates/resume/main.tex", "utf8");
      const resumeSource = createJakeResumeSource(template, posting as DiscoveredJob,
        parseApprovedHostedProfile(profileBytes, candidateId));
      expect(resumeSource.latex).toContain("Built a TypeScript dashboard");
      expect(resumeSource.latex).not.toContain("Created a SQL search tool");
      expect(resumeSource.claimIds).toContain(`${profileArtifactId}:experience-0:0`);
      expect((await worker.fetch(request("/api/applications/runs", body), env)).status).toBe(200);
      expect(runs.size).toBe(1);

      const enqueueBody = { candidateId, runId };
      expect((await worker.fetch(request("/api/applications/enqueue", enqueueBody), env)).status).toBe(202);
      expect((await worker.fetch(request("/api/applications/enqueue", enqueueBody), env)).status).toBe(202);
      expect(dispatches.size).toBe(1);
      expect(dispatches.get(runId)?.state).toBe("launched");
      expect(launch).toHaveBeenCalledTimes(1);
      expect(queueSend).not.toHaveBeenCalled();

      expect((await worker.fetch(request("/api/applications/enqueue", enqueueBody, "x.y.z"), env)).status).toBe(403);
      paid = false;
      expect((await worker.fetch(request("/api/applications/enqueue", enqueueBody), env)).status).toBe(403);
      expect(dispatches.size).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
