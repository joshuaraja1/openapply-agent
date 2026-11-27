import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { officialJobKey } from "../src/cloud/durable-journal.js";
import { verifiedOfficialLead } from "../src/cloud/official-lead-sync.js";
import { runCloudPreSubmitPreview, type CloudPreviewPorts } from "../src/cloud/cloud-preview-runtime.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const job = { provider: "greenhouse", employerId: "acme", requisitionId: "123456" };
const lead = verifiedOfficialLead({ provider: "greenhouse", boardToken: "acme", company: "Acme" }, {
  id: "greenhouse:acme:123456", provider: "greenhouse", company: "Acme",
  title: "Software Engineer", descriptionText: "Python services",
  applicationUrl: "https://boards.greenhouse.io/acme/jobs/123456",
  sourceUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
  location: null, department: null, employmentType: null, workplaceType: null,
  compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null,
}, new Date());
const scope = { candidateId, runId };
const entitlement = { kind: "free-grant", subjectId: "subject-1", grantId: "test",
  approvedBy: "staging", startsAt: "2020-01-01T00:00:00Z",
  endsAt: "2099-01-01T00:00:00Z", revokedAt: null };

function ports(profilePath: string): CloudPreviewPorts & { cleanup: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>; binding: ReturnType<typeof vi.fn>;
  outcome: ReturnType<typeof vi.fn> } {
  const cleanup = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const binding = vi.fn(async () => ({ profileArtifactId: "artifact-id", lead }));
  const outcome = vi.fn(async () => {});
  return {
    dispatch: { read: async () => ({ state: "launched", body: JSON.stringify({
      version: 1, candidateId, runId, kind: "apply", scheduledAt: new Date().toISOString(),
    }) }) },
    runRecords: { loadIdentity: async () => ({ subjectId: "subject-1", job }) },
    authorization: { ownsRun: async () => true, hasCurrentConsent: async () => true },
    billing: { loadEntitlements: async () => [entitlement] },
    journal: { acquireLease: async () => "lease-id", renewLease: async () => true,
      releaseLease: release,
      readSubmission: async () => ({ status: "not_started" }) },
    preview: { loadBinding: binding, recordOutcome: outcome },
    vault: { restoreToPrivateTemp: async () => ({ path: profilePath, cleanup }) },
    cleanup, release, binding, outcome,
  };
}

describe("cloud employer-form preview task", () => {
  it("binds one launched run, restores its reviewed profile, and releases every lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-cloud-preview-test-"));
    const path = join(root, "profile.json");
    await writeFile(path, '{"test":true}');
    try {
      const p = ports(path);
      const preview = vi.fn(async input => {
        expect(input.candidateId).toBe(candidateId);
        expect(officialJobKey(input.runJob)).toBe(officialJobKey(job));
        expect(input.lead.canonicalUrl).toBe(lead.canonicalUrl);
        expect(new TextDecoder().decode(input.profileBytes)).toBe('{"test":true}');
        return { status: "ready-for-review" as const, blockers: [], job,
          resumeSha256: "a".repeat(64), uploaded: true };
      });
      const result = await runCloudPreSubmitPreview(scope, { work: root,
        browser: join(root, "browser") }, p, preview);
      expect(result.status).toBe("ready-for-review");
      expect(preview).toHaveBeenCalledOnce();
      expect(p.binding).toHaveBeenCalledOnce();
      expect(p.outcome).toHaveBeenCalledWith("lease-id", job,
        { status: "ready-for-review", blockerCount: 0, resumeSha256: "a".repeat(64), uploaded: true });
      expect(p.cleanup).toHaveBeenCalledOnce();
      expect(p.release).toHaveBeenCalledOnce();
      expect(await readFile(path, "utf8")).toBe('{"test":true}');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a prior submit intent before acquiring a lease or reading artifacts", async () => {
    const p = ports("/no/profile");
    const acquire = vi.fn(async () => "lease-id");
    p.journal.acquireLease = acquire;
    p.journal.readSubmission = async () => ({ status: "needs_reconciliation" });
    const preview = vi.fn();
    await expect(runCloudPreSubmitPreview(scope, { work: "/tmp", browser: "/tmp/browser" },
      p, preview)).rejects.toThrow("submission intent");
    expect(acquire).not.toHaveBeenCalled();
    expect(p.binding).not.toHaveBeenCalled();
    expect(p.outcome).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses wrong-run dispatch and revoked consent before touching a profile", async () => {
    const p = ports("/no/profile");
    p.dispatch.read = async () => ({ state: "launched", body: JSON.stringify({
      version: 1, candidateId, runId: "00000000-0000-4000-8000-000000000009",
      kind: "apply", scheduledAt: new Date().toISOString(),
    }) });
    await expect(runCloudPreSubmitPreview(scope, { work: "/tmp", browser: "/tmp/browser" },
      p, vi.fn())).rejects.toThrow("dispatch");
    expect(p.binding).not.toHaveBeenCalled();
    expect(p.outcome).not.toHaveBeenCalled();
    p.dispatch = ports("/no/profile").dispatch;
    p.authorization.hasCurrentConsent = async () => false;
    await expect(runCloudPreSubmitPreview(scope, { work: "/tmp", browser: "/tmp/browser" },
      p, vi.fn())).rejects.toThrow("not authorized");
    expect(p.binding).not.toHaveBeenCalled();
    expect(p.outcome).not.toHaveBeenCalled();
  });

  it("cleans restored state and lease when the browser preview fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-cloud-preview-test-"));
    const path = join(root, "profile.json");
    await writeFile(path, '{"test":true}');
    try {
      const p = ports(path);
      await expect(runCloudPreSubmitPreview(scope, { work: root,
        browser: join(root, "browser") }, p, async () => {
        throw new Error("Browser failed");
      })).rejects.toThrow("Browser failed");
      expect(p.cleanup).toHaveBeenCalledOnce();
      expect(p.outcome).not.toHaveBeenCalled();
      expect(p.release).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
