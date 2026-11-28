import { createHash, randomUUID } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { requestScopedArtifactCredentials, uploadEncryptedHandoff } from "./aws-artifact-broker-client.js";
import { KmsDataKeys, S3ArtifactStore } from "./aws-artifact-store.js";
import { CandidateVault, handoffObjectKey } from "./candidate-vault.js";
import { decodeHostedHandoff, encodeHostedHandoff, type HostedHandoffState } from "./hosted-handoff-state.js";
import type { OfficialJobIdentity } from "./durable-journal.js";

export interface AwsHandoffConfig {
  region: string; bucket: string; kmsKeyArn: string; brokerArn: string;
}

/** The browser task never receives S3 Put. Only the broker can atomically link
 * an encrypted object to the live dispatch row before submit intent. */
export function createAwsHostedHandoffStore(lambda: Pick<LambdaClient, "send">,
  config: AwsHandoffConfig,
  scope: { candidateId: string; runId: string; capability: string }) {
  if (!config.kmsKeyArn.includes(`:${config.region}:`) || !config.bucket || !config.brokerArn) {
    throw new Error("Handoff storage configuration is incomplete");
  }
  async function grant(leaseToken: string) {
    const issued = await requestScopedArtifactCredentials(lambda, config.brokerArn,
      scope.capability, { candidateId: scope.candidateId, runId: scope.runId, leaseToken });
    return { accessKeyId: issued.accessKeyId, secretAccessKey: issued.secretAccessKey,
      sessionToken: issued.sessionToken };
  }
  return {
    async save(leaseToken: string, state: HostedHandoffState): Promise<{
      artifactId: string; sha256: string;
    }> {
      if (state.candidateId !== scope.candidateId || state.runId !== scope.runId) {
        throw new Error("Handoff scope mismatch");
      }
      const artifactId = randomUUID();
      const bytes = encodeHostedHandoff(state);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        const credentials = await grant(leaseToken);
        const key = handoffObjectKey(scope.candidateId, scope.runId, artifactId);
        const objects = {
          async putCreateOnly(actualKey: string, body: Uint8Array) {
            if (actualKey !== key) throw new Error("Handoff object key mismatch");
            await uploadEncryptedHandoff(lambda, config.brokerArn, scope.capability,
              { ...scope, leaseToken, artifactId, sha256 }, body);
          },
          async get(): Promise<Uint8Array> { throw new Error("Handoff read unavailable during save"); },
          async purgeVersions(): Promise<void> { throw new Error("Worker cannot purge handoffs"); },
        };
        await new CandidateVault(new KmsDataKeys(new KMSClient({ region: config.region,
          credentials }), config.kmsKeyArn), objects)
          .putHandoff(scope.candidateId, scope.runId, artifactId, bytes);
        return { artifactId, sha256 };
      } finally { bytes.fill(0); }
    },
    async load(leaseToken: string, pointer: { artifactId: string; sha256: string },
      expected: { job: OfficialJobIdentity; employerHost: string }): Promise<HostedHandoffState> {
      const credentials = await grant(leaseToken);
      const vault = new CandidateVault(new KmsDataKeys(new KMSClient({ region: config.region,
        credentials }), config.kmsKeyArn), new S3ArtifactStore(new S3Client({
        region: config.region, credentials }), config.bucket));
      const bytes = await vault.readHandoffVerified(scope.candidateId, scope.runId,
        pointer.artifactId, pointer.sha256);
      try {
        return decodeHostedHandoff(bytes, { candidateId: scope.candidateId,
          runId: scope.runId, ...expected });
      } finally { bytes.fill(0); }
    },
  };
}
