import { describe, expect, it, vi } from "vitest";
import { DELETE_HOLD_SECONDS, deleteCandidateAccount, retryCandidateDeletions, type CandidateDeletionDeps } from "../src/hosted/candidate-deletion.js";
import { handleCandidateDeletionHttp } from "../src/hosted/candidate-deletion-http.js";

const candidateId = "11111111-1111-4111-8111-111111111111";
const subjectId = "candidate-subject";
const t0 = new Date("2026-11-26T12:00:00.000Z");

function fixture() {
  let marker: { state: "pending" | "complete"; subjectId: string; notBeforeEpoch: number } | undefined;
  let active = false;
  let claimed = false;
  const purge = vi.fn(async () => {});
  const deps: CandidateDeletionDeps = {
    candidateIdForSubject: () => candidateId,
    vault: { deleteCandidate: purge },
    store: {
      async begin(_candidate, subject, notBeforeEpoch) {
        marker ??= { state: "pending", subjectId: subject, notBeforeEpoch };
        return marker;
      },
      async status() { return marker?.state ?? "none"; },
      async due(nowEpoch) { return marker?.state === "pending" && marker.notBeforeEpoch <= nowEpoch
        ? [{ candidateId, subjectId }] : []; },
      async defer() {},
      async hasActiveWriters() { return active; },
      async claimPurge() { if (claimed) return false; claimed = true; return true; },
      async releasePurge() { claimed = false; },
      async purgeMetadata() { return true; },
      async markComplete() { if (!marker) throw new Error("No marker"); marker.state = "complete"; },
    },
  };
  return { deps, purge, setActive(value: boolean) { active = value; },
    marker: () => marker };
}

describe("hosted candidate deletion", () => {
  it("writes a durable tombstone first, waits out uploads, then retries a full purge", async () => {
    const test = fixture();
    test.setActive(true);
    expect(await deleteCandidateAccount(subjectId, test.deps, t0)).toEqual({ state: "pending" });
    expect(test.marker()?.state).toBe("pending");
    expect(test.purge).not.toHaveBeenCalled();
    const later = new Date(t0.getTime() + 241_000);
    expect(await deleteCandidateAccount(subjectId, test.deps, later)).toEqual({ state: "pending" });
    expect(test.purge).not.toHaveBeenCalled();
    test.setActive(false);
    expect(await deleteCandidateAccount(subjectId, test.deps, later)).toEqual({ state: "complete" });
    expect(test.purge).toHaveBeenCalledExactlyOnceWith(candidateId);
    expect(await deleteCandidateAccount(subjectId, test.deps, later)).toEqual({ state: "complete" });
    expect(test.purge).toHaveBeenCalledTimes(1);
  });

  it("does not mark deletion complete when S3 purge fails", async () => {
    const test = fixture();
    await deleteCandidateAccount(subjectId, test.deps, t0);
    test.purge.mockRejectedValueOnce(new Error("Partial S3 version deletion"));
    const later = new Date(t0.getTime() + 241_000);
    await expect(deleteCandidateAccount(subjectId, test.deps, later)).rejects.toThrow("Partial");
    expect(test.marker()?.state).toBe("pending");
    expect(await deleteCandidateAccount(subjectId, test.deps, later)).toEqual({ state: "complete" });
  });

  it("keeps a tombstone pending when ledger cleanup needs another bounded pass", async () => {
    const test = fixture();
    const cleanup = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    test.deps.store.purgeMetadata = cleanup;
    await deleteCandidateAccount(subjectId, test.deps, t0);
    const later = new Date(t0.getTime() + 241_000);
    expect(await deleteCandidateAccount(subjectId, test.deps, later)).toEqual({ state: "pending" });
    expect(test.marker()?.state).toBe("pending");
    expect(await deleteCandidateAccount(subjectId, test.deps, later)).toEqual({ state: "complete" });
    expect(test.purge).toHaveBeenCalledTimes(2); // Version purge is safely repeatable.
  });

  it("requires the authenticated subject and exact origin without requiring payment", async () => {
    const test = fixture();
    const deps = { ...test.deps, appOrigin: "https://app.example.com",
      verifySubject: async () => subjectId };
    const request = (origin: string, token = "Bearer a.b.c") => new Request(
      "https://app.example.com/api/candidates/delete", { method: "POST",
        headers: { origin, authorization: token } });
    expect((await handleCandidateDeletionHttp(request("https://evil.example"), deps)).status).toBe(403);
    expect((await handleCandidateDeletionHttp(request("https://app.example.com", ""), deps)).status).toBe(401);
    const accepted = await handleCandidateDeletionHttp(request("https://app.example.com"), deps);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ state: "pending" });
    expect(test.marker()?.subjectId).toBe(subjectId);
  });

  it("resumes after the hold without a second browser request and retries partial S3 failure", async () => {
    const test = fixture();
    await deleteCandidateAccount(subjectId, test.deps, t0);
    test.purge.mockRejectedValueOnce(new Error("partial S3 deletion"));
    const later = new Date(t0.getTime() + 241_000);
    expect(await retryCandidateDeletions(test.deps, later)).toEqual({ attempted: 1, completed: 0, failed: 1 });
    expect(test.marker()?.state).toBe("pending");
    expect(await retryCandidateDeletions(test.deps, later)).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(test.marker()?.state).toBe("complete");
    expect(await retryCandidateDeletions(test.deps, later)).toEqual({ attempted: 0, completed: 0, failed: 0 });
  });

  it("returns authenticated status without exposing identity or starting deletion", async () => {
    const test = fixture();
    const deps = { ...test.deps, appOrigin: "https://app.example.com",
      verifySubject: async () => subjectId };
    const request = new Request("https://app.example.com/api/candidates/deletion-status", {
      method: "POST", headers: { origin: deps.appOrigin, authorization: "Bearer a.b.c" } });
    const response = await handleCandidateDeletionHttp(request, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "none" });
    expect(test.marker()).toBeUndefined();
    expect(JSON.stringify(Object.fromEntries(response.headers))).not.toContain(subjectId);
  });

  it("never turns a partial purge into an HTTP completion response", async () => {
    const test = fixture();
    const deps = { ...test.deps, appOrigin: "https://app.example.com",
      verifySubject: async () => subjectId };
    const request = () => new Request("https://app.example.com/api/candidates/delete", {
      method: "POST", headers: { origin: deps.appOrigin, authorization: "Bearer a.b.c" } });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      expect((await handleCandidateDeletionHttp(request(), deps)).status).toBe(202);
      test.purge.mockRejectedValueOnce(new Error(`partial S3 deletion for ${subjectId}`));
      vi.setSystemTime(new Date(t0.getTime() + DELETE_HOLD_SECONDS * 1000 + 1000));
      const failed = await handleCandidateDeletionHttp(request(), deps);
      expect(failed.status).toBe(503);
      const body = await failed.text();
      expect(JSON.parse(body)).toEqual({ state: "pending" });
      expect(body).not.toContain(subjectId);
    } finally { vi.useRealTimers(); }
  });
});
