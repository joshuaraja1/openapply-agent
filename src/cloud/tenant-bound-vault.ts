import { z } from "zod";

const uuid = z.uuid();

function canonicalId(value: string, label: string): string {
  const parsed = uuid.parse(value);
  if (parsed !== parsed.toLowerCase()) throw new Error(`${label} must be a lowercase UUID`);
  return parsed;
}

export type CandidateVaultAction = "read" | "write" | "delete-artifact" | "delete-candidate";

export interface CandidateVaultScope {
  candidateId: string;
  runId: string;
  leaseToken: string;
}

/**
 * A trusted implementation must hold the authorization/fence for the whole
 * operation. In particular, deletion must tombstone, stop writers, then purge.
 */
export interface CandidateAccessFence {
  withAuthorizedAccess<T>(scope: CandidateVaultScope, action: CandidateVaultAction,
    operation: () => Promise<T>): Promise<T>;
}

export interface CandidateArtifactPort {
  put(candidateId: string, artifactId: string, bytes: Uint8Array): Promise<void>;
  read(candidateId: string, artifactId: string): Promise<Buffer>;
  restoreToPrivateTemp(candidateId: string, artifactId: string): Promise<{
    path: string; cleanup(): Promise<void>;
  }>;
  deleteArtifact(candidateId: string, artifactId: string): Promise<void>;
  deleteCandidate(candidateId: string): Promise<void>;
}

/** Code-level tenant boundary for a single authorized run; not an IAM boundary. */
export class TenantBoundCandidateVault {
  private readonly scope: CandidateVaultScope;

  constructor(private readonly vault: CandidateArtifactPort, private readonly fence: CandidateAccessFence,
    scope: CandidateVaultScope) {
    this.scope = Object.freeze({
      candidateId: canonicalId(scope.candidateId, "Candidate ID"),
      runId: canonicalId(scope.runId, "Run ID"),
      leaseToken: canonicalId(scope.leaseToken, "Lease token"),
    });
  }

  private assertBound(candidateId: string): string {
    const canonical = canonicalId(candidateId, "Candidate ID");
    if (canonical !== this.scope.candidateId) throw new Error("Candidate is outside this run's vault scope");
    return canonical;
  }

  async put(candidateId: string, artifactId: string, bytes: Uint8Array): Promise<void> {
    const bound = this.assertBound(candidateId);
    const artifact = canonicalId(artifactId, "Artifact ID");
    await this.fence.withAuthorizedAccess(this.scope, "write", () => this.vault.put(bound, artifact, bytes));
  }

  async read(candidateId: string, artifactId: string): Promise<Buffer> {
    const bound = this.assertBound(candidateId);
    const artifact = canonicalId(artifactId, "Artifact ID");
    return this.fence.withAuthorizedAccess(this.scope, "read", () => this.vault.read(bound, artifact));
  }

  async restoreToPrivateTemp(candidateId: string, artifactId: string): Promise<{
    path: string; cleanup(): Promise<void>;
  }> {
    const bound = this.assertBound(candidateId);
    const artifact = canonicalId(artifactId, "Artifact ID");
    return this.fence.withAuthorizedAccess(this.scope, "read",
      () => this.vault.restoreToPrivateTemp(bound, artifact));
  }

  async deleteArtifact(candidateId: string, artifactId: string): Promise<void> {
    const bound = this.assertBound(candidateId);
    const artifact = canonicalId(artifactId, "Artifact ID");
    await this.fence.withAuthorizedAccess(this.scope, "delete-artifact",
      () => this.vault.deleteArtifact(bound, artifact));
  }

  async deleteCandidate(candidateId: string): Promise<void> {
    const bound = this.assertBound(candidateId);
    await this.fence.withAuthorizedAccess(this.scope, "delete-candidate",
      () => this.vault.deleteCandidate(bound));
  }
}
