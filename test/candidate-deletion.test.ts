import { describe, expect, it, vi } from "vitest";
import { deleteCandidateAccount, type CandidateDeletionDeps } from "../src/hosted/candidate-deletion.js";
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
});
