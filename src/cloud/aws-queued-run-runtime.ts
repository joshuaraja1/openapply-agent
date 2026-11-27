import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { KmsDataKeys, S3ArtifactStore } from "./aws-artifact-store.js";
import { SqsApplicationQueueReceiver } from "./aws-queue-consumer.js";
import { CandidateVault, receiptObjectKey } from "./candidate-vault.js";
import { DurableApplicationJournal } from "./durable-journal.js";
import { decodeCloudRunEnvelope } from "./run-envelope.js";
import { handleQueuedApplication, type CloudRunPorts, type CloudRunOutcome } from "./queued-run.js";
import { requestScopedArtifactCredentials, uploadEncryptedReceipt } from "./aws-artifact-broker-client.js";

export interface AwsQueuedRunConfiguration {
  ledgerTable: string;
  entitlementTable: string;
  artifactBucket: string;
  artifactKmsKeyArn: string;
  applicationQueueUrl: string;
  artifactBrokerArn: string;
}

/** No browser adapter is supplied by this module. Artifact clients are built
 * only from broker-issued, short-lived per-candidate credentials. The ECS task
 * role must have no direct S3/KMS permission. */
export function createAwsQueuedRunRuntime(
  clients: { dynamo: DynamoDBDocumentClient; sqs: SQSClient; lambda: LambdaClient },
  config: AwsQueuedRunConfiguration,
  scope: { candidateId: string; runId: string; capability: string },
  application: CloudRunPorts["application"],
  receiptVerifier: CloudRunPorts["receiptVerifier"],
): { receiver: SqsApplicationQueueReceiver;
  handle(message: { body: string; receiptHandle: string }): Promise<CloudRunOutcome> } {
  if (!config.ledgerTable || !config.entitlementTable || !config.artifactBucket
    || !config.artifactKmsKeyArn || !config.applicationQueueUrl || !config.artifactBrokerArn) {
    throw new Error("AWS application runtime configuration is incomplete");
  }
  const region = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\//.exec(config.artifactKmsKeyArn)?.[1];
  if (!region || !scope.candidateId || !scope.runId || !scope.capability) {
    throw new Error("Artifact run scope is unavailable");
  }
  const awsRegion = region;
  const admission = new DynamoHostedRunAdmission(clients.dynamo, config.ledgerTable);
  const receiver = new SqsApplicationQueueReceiver(clients.sqs, config.applicationQueueUrl);
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
    billing: new DynamoCandidatePlanStatus(clients.dynamo, config.entitlementTable),
    authorization: admission,
    runRecords: admission,
    journal: new DurableApplicationJournal(clients.dynamo, config.ledgerTable),
    vault,
    application,
    receiptVerifier,
    queue: receiver,
  };
  return { receiver, async handle(message) {
    const envelope = decodeCloudRunEnvelope(message.body);
    if (envelope.candidateId !== scope.candidateId || envelope.runId !== scope.runId) {
      throw new Error("Artifact run scope mismatch");
    }
    return handleQueuedApplication(message, ports);
  } };
}
