import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TenantBoundCandidateVault, type CandidateAccessFence, type CandidateArtifactPort }
  from "../src/cloud/tenant-bound-vault.js";

const candidateId = "ec5a592a-a5ea-409f-b21b-0064558c72bb";
const otherCandidate = "19a5c885-4633-4436-93fb-ac7974b6b755";
const artifactId = "4fd29cf4-edda-4e66-9440-172c167bb0aa";
const scope = { candidateId, runId: "e4590bf1-91c4-4a63-9203-a8715a68d8d4",
  leaseToken: randomUUID() };

function harness() {
  let authorized = false;
  let deletionApproved = false;
  const calls: string[] = [];
  const vault: CandidateArtifactPort = {
    put: vi.fn(async () => { calls.push("put"); }),
    read: vi.fn(async () => { calls.push("read"); return Buffer.from("candidate data"); }),
    restoreToPrivateTemp: vi.fn(async () => {
      calls.push("restore"); return { path: "/private/profile", cleanup: async () => {} };
    }),
    deleteArtifact: vi.fn(async () => { calls.push("deleteArtifact"); }),
    deleteCandidate: vi.fn(async () => { calls.push("deleteCandidate"); }),
  };
  const fence: CandidateAccessFence = {
    async withAuthorizedAccess(bound, action, operation) {
      calls.push(`fence:${action}`);
      if (!authorized || bound.candidateId !== candidateId || bound.runId !== scope.runId
        || bound.leaseToken !== scope.leaseToken) throw new Error("Run is not authorized");
      if (action === "delete-candidate" && !deletionApproved) {
        throw new Error("Candidate deletion fence is not held");
      }
      return operation();
    },
  };
  return { bound: new TenantBoundCandidateVault(vault, fence, scope), calls,
    authorize() { authorized = true; },
    approveDeletion() { deletionApproved = true; }, vault };
}

describe("tenant-bound cloud vault", () => {
  it("denies artifact access until the current run is authorized", async () => {
    const h = harness();
    await expect(h.bound.restoreToPrivateTemp(candidateId, artifactId)).rejects.toThrow("not authorized");
    await expect(h.bound.put(candidateId, artifactId, Buffer.from("private"))).rejects.toThrow("not authorized");
    expect(h.calls).toEqual(["fence:read", "fence:write"]);
  });

  it("checks scope on each read and write", async () => {
    const h = harness(); h.authorize();
    expect(await h.bound.read(candidateId, artifactId)).toEqual(Buffer.from("candidate data"));
    await h.bound.put(candidateId, artifactId, Buffer.from("private"));
    expect(h.calls).toEqual(["fence:read", "read", "fence:write", "put"]);
    expect(h.vault.read).toHaveBeenCalledWith(candidateId, artifactId);
  });

  it("rejects another candidate and noncanonical case before reaching the fence or vault", async () => {
    const h = harness(); h.authorize();
    await expect(h.bound.read(otherCandidate, artifactId)).rejects.toThrow("outside");
    await expect(h.bound.put(otherCandidate, artifactId, Buffer.alloc(0))).rejects.toThrow("outside");
    await expect(h.bound.restoreToPrivateTemp(otherCandidate, artifactId)).rejects.toThrow("outside");
    await expect(h.bound.deleteArtifact(otherCandidate, artifactId)).rejects.toThrow("outside");
    await expect(h.bound.deleteCandidate(otherCandidate)).rejects.toThrow("outside");
    await expect(h.bound.read(candidateId.toUpperCase(), artifactId)).rejects.toThrow("lowercase");
    await expect(h.bound.read(candidateId, artifactId.toUpperCase())).rejects.toThrow("lowercase");
    expect(h.calls).toEqual([]);
  });

  it("requires action-specific authorization for artifact and account deletion", async () => {
    const h = harness(); h.authorize();
    await h.bound.deleteArtifact(candidateId, artifactId);
    await expect(h.bound.deleteCandidate(candidateId)).rejects.toThrow("deletion fence");
    expect(h.vault.deleteCandidate).not.toHaveBeenCalled();
    h.approveDeletion();
    await h.bound.deleteCandidate(candidateId);
    expect(h.calls).toEqual(["fence:delete-artifact", "deleteArtifact",
      "fence:delete-candidate",
      "fence:delete-candidate", "deleteCandidate"]);
  });

  it("rejects noncanonical binding before any artifact access", () => {
    const h = harness();
    expect(() => new TenantBoundCandidateVault(h.vault, {
      withAuthorizedAccess: async (_scope, _action, operation) => operation(),
    }, { ...scope, candidateId: candidateId.toUpperCase() })).toThrow("lowercase");
  });
});
