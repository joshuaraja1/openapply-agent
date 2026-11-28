import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { KmsDataKeys, S3ArtifactStore } from "./aws-artifact-store.js";
import { CandidateVault, receiptObjectKey } from "./candidate-vault.js";
import { decodeCloudRunEnvelope } from "./run-envelope.js";
import { handleQueuedApplication, type CloudRunPorts, type CloudRunOutcome } from "./queued-run.js";
import { requestScopedArtifactCredentials, uploadEncryptedReceipt } from "./aws-artifact-broker-client.js";
import { createBrokeredRunState } from "./aws-run-state-broker-client.js";
import { createAwsHostedHandoffStore } from "./aws-hosted-handoff.js";

export interface AwsQueuedRunConfiguration {
  artifactBucket: string;
  artifactKmsKeyArn: string;
  artifactBrokerArn: string;
}

/** No browser adapter is supplied by this module. Artifact clients are built
 * only from broker-issued, short-lived per-candidate credentials. The ECS task
 * role must have no direct S3/KMS permission. */
export function createAwsQueuedRunRuntime(
  clients: { lambda: LambdaClient },
  config: AwsQueuedRunConfiguration,
  scope: { candidateId: string; runId: string; capability: string },
  application: CloudRunPorts["application"],
  receiptVerifier: CloudRunPorts["receiptVerifier"],
  syntheticProbe?: CloudRunPorts["syntheticProbe"],
): { runExact(): Promise<CloudRunOutcome> } {
  if (!config.artifactBucket || !config.artifactKmsKeyArn || !config.artifactBrokerArn) {
    throw new Error("AWS application runtime configuration is incomplete");
  }
  const region = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\//.exec(config.artifactKmsKeyArn)?.[1];
  if (!region || !scope.candidateId || !scope.runId || !scope.capability) {
    throw new Error("Artifact run scope is unavailable");
  }
  const awsRegion = region;
  const state = createBrokeredRunState(clients.lambda, config.artifactBrokerArn,
    scope.capability, { candidateId: scope.candidateId, runId: scope.runId });
  const handoffStore = createAwsHostedHandoffStore(clients.lambda, {
    region: awsRegion, bucket: config.artifactBucket,
    kmsKeyArn: config.artifactKmsKeyArn, brokerArn: config.artifactBrokerArn,
  }, scope);
  async function scopedGrant(candidateId: string, runId: string, leaseToken: string) {
    if (candidateId !== scope.candidateId || runId !== scope.runId) {
      throw new Error("Artifact run scope mismatch");
    }
    return requestScopedArtifactCredentials(clients.lambda,
      config.artifactBrokerArn, scope.capability, { candidateId, runId, leaseToken });
  }
  async function scopedVault(candidateId: string, runId: string, leaseToken: string) {
    const grant = await scopedGrant(candidateId, runId, leaseToken);
    const credentials = { accessKeyId: grant.accessKeyId,
      secretAccessKey: grant.secretAccessKey, sessionToken: grant.sessionToken };
    return new CandidateVault(new KmsDataKeys(new KMSClient({ region: awsRegion, credentials }),
      config.artifactKmsKeyArn), new S3ArtifactStore(new S3Client({ region: awsRegion, credentials }),
      config.artifactBucket));
  }
  const vault: CloudRunPorts["vault"] = {
    async restoreToPrivateTemp(candidateId, runId, leaseToken, artifactId) {
      return (await scopedVault(candidateId, runId, leaseToken))
        .restoreToPrivateTemp(candidateId, artifactId);
    },
    async put(candidateId, runId, leaseToken, artifactId, bytes) {
      const grant = await scopedGrant(candidateId, runId, leaseToken);
      const credentials = { accessKeyId: grant.accessKeyId,
        secretAccessKey: grant.secretAccessKey, sessionToken: grant.sessionToken };
      const key = receiptObjectKey(candidateId, runId, artifactId);
      const brokerStore = {
        async putCreateOnly(actualKey: string, body: Uint8Array) {
          if (actualKey !== key) throw new Error("Receipt object key mismatch");
          await uploadEncryptedReceipt(clients.lambda, config.artifactBrokerArn,
            scope.capability, { candidateId, runId, leaseToken, artifactId }, body);
        },
        async get(): Promise<Uint8Array> { throw new Error("Receipt read unavailable to worker"); },
        async purgeVersions(): Promise<void> { throw new Error("Worker cannot purge receipts"); },
      };
      return new CandidateVault(new KmsDataKeys(new KMSClient({ region: awsRegion, credentials }),
        config.artifactKmsKeyArn), brokerStore).putReceipt(candidateId, runId, artifactId, bytes);
    },
  };
  const ports: CloudRunPorts = {
    billing: state.billing,
    authorization: state.authorization,
    runRecords: state.runRecords,
    dispatch: { readStatus: () => state.dispatch.readStatus() },
    journal: state.journal,
    vault,
    handoff: { async save(leaseToken, handoff) {
      await handoffStore.save(leaseToken, handoff);
      // The checkpoint pointer exists before the broker makes this task
      // terminal; its transition checks the same lease and no submit intent.
      await state.dispatch.markNeedsHuman(leaseToken, handoff.job);
    } },
    application,
    receiptVerifier,
    ...(syntheticProbe ? { syntheticProbe } : {}),
    queue: { async acknowledge(receiptHandle) {
      if (receiptHandle !== scope.runId) throw new Error("Dispatch run scope mismatch");
      await state.dispatch.markCompleted();
    }, async acknowledgeHandoff(receiptHandle) {
      if (receiptHandle !== scope.runId) throw new Error("Dispatch run scope mismatch");
      // No SQS message is polled by this exact-run runtime. The broker already
      // committed needs_human and removed the dispatch row from the pending GSI.
    } },
  };
  return { async runExact() {
    const row = await state.dispatch.read();
    const envelope = decodeCloudRunEnvelope(row.body);
    if (envelope.candidateId !== scope.candidateId || envelope.runId !== scope.runId
      || envelope.kind !== "apply") throw new Error("Dispatch run scope mismatch");
    return handleQueuedApplication({ body: row.body, receiptHandle: scope.runId }, ports);
  } };
}
