import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCloudBrowserTask } from "../src/cloud/cloud-browser-task-cli.js";
import { encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";
import { handleQueuedApplication, type CloudRunPorts, type VerifiedReceipt }
  from "../src/cloud/queued-run.js";
import { SyntheticBrowserApplication, SyntheticReceiptVerifier }
  from "../src/cloud/synthetic-browser-application.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const runId = "e4590bf1-91c4-4a63-9203-a8715a68d8d4";
const artifactId = "8c231a91-c73b-4e2d-b085-5d5ebf302311";
const job = { provider: "synthetic", employerId: "fixture", requisitionId: "109" };
const confirmation = "Application received for requisition 109";

function profile(id = candidateId) {
  return { version: 1, provenance: "candidate-entered-and-reviewed", candidateId: id,
    workAuthorization: "Authorized to work", sponsorshipRequiredNowOrFuture: false,
    consent: { storage: true, automation: true, reviewed: true } };
}

async function withProfile<T>(id: string, fn: (path: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "openapply-synthetic-test-"));
  const path = join(root, "profile.json");
  try {
    await writeFile(path, JSON.stringify(profile(id)), { mode: 0o600 });
    return await fn(path);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("synthetic-only cloud browser adapter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not offer a real-site task mode or silently start an AWS poll", async () => {
    vi.stubEnv("OPENAPPLY_CLOUD_TASK_MODE", "real");
    await expect(runCloudBrowserTask()).rejects.toThrow("disabled");
    vi.stubEnv("OPENAPPLY_CLOUD_TASK_MODE", "synthetic");
    vi.stubEnv("OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK", "0");
    await expect(runCloudBrowserTask()).rejects.toThrow("disabled");
  });

  it("rejects foreign profiles and any real employer before launching Chromium", async () => {
    const application = new SyntheticBrowserApplication();
    await withProfile("cbcb7d55-503d-4a93-81b9-0387672282d8", async path => {
      await expect(application.prepare(path, job, candidateId)).rejects.toThrow("another candidate");
      await expect(application.prepare(path, { ...job, provider: "greenhouse" }, candidateId))
        .rejects.toThrow();
    });
  });

  it("accepts only an exact, explicit synthetic requisition receipt", async () => {
    const verifier = new SyntheticReceiptVerifier();
    const receipt = (value: object): VerifiedReceipt => ({ job,
      evidence: new TextEncoder().encode(JSON.stringify(value)) });
    const valid = { version: 1, job, url: "https://fixture.openapply.invalid/apply/109",
      confirmation };
    expect(await verifier.verify(receipt(valid), job)).toBe(true);
    expect(await verifier.verify(receipt({ ...valid, confirmation: "Submit clicked" }), job)).toBe(false);
    expect(await verifier.verify(receipt({ ...valid, url: "https://elsewhere.invalid/apply/109" }), job))
      .toBe(false);
    expect(await verifier.verify(receipt(valid), { ...job, requisitionId: "110" })).toBe(false);
  });

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "records a broker grant before the final click and crashes at the post-click checkpoint",
    async () => withProfile(candidateId, async profilePath => {
      const events: string[] = [];
      const application = new SyntheticBrowserApplication({
        async recordFinalClick(candidate, run, token, target) {
          expect({ candidate, run, token, target }).toEqual({ candidate: candidateId,
            run: runId, token: artifactId, target: job });
          events.push("audit");
          return true;
        },
        afterFinalClick() { events.push("after-click"); throw new Error("simulated task exit 86"); },
      });
      const prepared = await application.prepare(profilePath, job, candidateId,
        { runId, leaseToken: artifactId });
      try {
        await expect(prepared.submitOnce(async () => true)).rejects.toThrow("task exit 86");
        await expect(prepared.submitOnce(async () => true)).rejects.toThrow("no longer available");
        expect(events).toEqual(["audit", "after-click"]);
      } finally { await prepared.close?.(); }
    }), 45_000,
  );

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "uses real owned Chromium only after durable intent and never clicks twice on redelivery",
    async () => withProfile(candidateId, async profilePath => {
      let status: "not_started" | "needs_reconciliation" | "confirmed" = "not_started";
      let clicks = 0;
      let restores = 0;
      let acknowledgements = 0;
      let savedReceipt: Uint8Array | undefined;
      const application = new SyntheticBrowserApplication();
      const verifier = new SyntheticReceiptVerifier();
      const ports: CloudRunPorts = {
        billing: { async loadEntitlements() { return [{ kind: "free-grant", subjectId: candidateId,
          grantId: "synthetic", approvedBy: "staging", startsAt: "2020-01-01T00:00:00Z",
          endsAt: "2099-01-01T00:00:00Z", revokedAt: null }]; } },
        authorization: { async ownsRun() { return true; }, async hasCurrentConsent() { return true; } },
        journal: {
          async acquireLease() { return runId; }, async renewLease() { return true; },
          async releaseLease() {},
          async readSubmission() { return { status }; },
          async beginSubmission() { status = "needs_reconciliation"; return artifactId; },
          async markUncertain() { status = "needs_reconciliation"; },
          async confirmAfterVerification() { status = "confirmed"; return true; },
        },
        runRecords: { async loadIdentity() { return { subjectId: candidateId,
          consentVersion: 1, job }; }, async loadProfileArtifactId() { return runId; } },
        vault: { async restoreToPrivateTemp() { restores++; return { path: profilePath,
          async cleanup() {} }; }, async put(_candidateId, _runId, _leaseToken, _artifactId, bytes) { savedReceipt = bytes; } },
        application: { async prepare(path, identity, candidate) {
          const prepared = await application.prepare(path, identity, candidate);
          return { ...prepared, async submitOnce(beforeClick) {
            clicks++; return prepared.submitOnce(beforeClick);
          } };
        } },
        receiptVerifier: verifier,
        queue: { async acknowledge() { acknowledgements++; } },
      };
      const message = { body: encodeCloudRunEnvelope({ version: 1, candidateId, runId,
        kind: "apply", scheduledAt: "2026-11-26T20:00:00Z" }).body,
        receiptHandle: "synthetic-receipt-handle" };
      expect(await handleQueuedApplication(message, ports)).toBe("confirmed");
      expect(status).toBe("confirmed");
      expect(savedReceipt).toBeDefined();
      expect(await verifier.verify({ job, evidence: savedReceipt! }, job)).toBe(true);
      expect(await handleQueuedApplication(message, ports)).toBe("already_confirmed");
      expect({ clicks, restores, acknowledgements }).toEqual({ clicks: 1, restores: 1,
        acknowledgements: 2 });
    }), 45_000,
  );

  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "fails closed on unpaid access and holds a post-click crash for reconciliation",
    async () => withProfile(candidateId, async profilePath => {
      let paid = false;
      let status: "not_started" | "needs_reconciliation" = "not_started";
      let clicks = 0;
      let receipt: VerifiedReceipt | undefined;
      const application = new SyntheticBrowserApplication();
      const verifier = new SyntheticReceiptVerifier();
      const ports: CloudRunPorts = {
        billing: { async loadEntitlements() { return paid ? [{ kind: "free-grant",
          subjectId: candidateId, grantId: "synthetic", approvedBy: "staging",
          startsAt: "2020-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z",
          revokedAt: null }] : []; } },
        authorization: { async ownsRun() { return true; }, async hasCurrentConsent() { return true; } },
        journal: {
          async acquireLease() { return runId; }, async renewLease() { return true; },
          async releaseLease() {}, async readSubmission() { return { status }; },
          async beginSubmission() { status = "needs_reconciliation"; return artifactId; },
          async markUncertain() {}, async confirmAfterVerification() { throw new Error("not reached"); },
        },
        runRecords: { async loadIdentity() { return { subjectId: candidateId,
          consentVersion: 1, job }; }, async loadProfileArtifactId() { return runId; } },
        vault: { async restoreToPrivateTemp() { return { path: profilePath,
          async cleanup() {} }; }, async put(_candidate, _run, _lease, reservedId, bytes) {
          expect(reservedId).toBe(artifactId);
          receipt = { job, evidence: bytes };
          throw new Error("simulated broker outage after final click");
        } },
        application: { async prepare(path, identity, candidate) {
          const prepared = await application.prepare(path, identity, candidate);
          return { ...prepared, async submitOnce(beforeClick) {
            clicks++; return prepared.submitOnce(beforeClick);
          } };
        } },
        receiptVerifier: verifier,
        queue: { async acknowledge() { throw new Error("must not acknowledge uncertain run"); } },
      };
      const message = { body: encodeCloudRunEnvelope({ version: 1, candidateId, runId,
        kind: "apply", scheduledAt: "2026-11-26T20:00:00Z" }).body,
        receiptHandle: "synthetic-crash-handle" };
      expect(await handleQueuedApplication(message, ports)).toBe("payment_required");
      expect(clicks).toBe(0);
      paid = true;
      await expect(handleQueuedApplication(message, ports)).rejects.toThrow("simulated broker outage");
      expect(clicks).toBe(1);
      expect(receipt && await verifier.verify(receipt, job)).toBe(true);
      expect(await handleQueuedApplication(message, ports)).toBe("needs_reconciliation");
      expect(clicks).toBe(1);
    }), 45_000,
  );
});
