import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { KmsDataKeys, S3ArtifactStore } from "./aws-artifact-store.js";
import { SqsApplicationQueueReceiver } from "./aws-queue-consumer.js";
import { CandidateVault } from "./candidate-vault.js";
import { DurableApplicationJournal } from "./durable-journal.js";
import { decodeCloudRunEnvelope } from "./run-envelope.js";
import { handleQueuedApplication, type CloudRunPorts, type CloudRunOutcome } from "./queued-run.js";
import type { ScopedArtifactCredentials } from "./artifact-credential-broker.js";

export interface AwsQueuedRunConfiguration {
  ledgerTable: string;
  entitlementTable: string;
  artifactBucket: string;
  artifactKmsKeyArn: string;
  applicationQueueUrl: string;
}

/** No browser adapter is supplied by this module. Artifact clients are built
 * only from broker-issued, short-lived per-candidate credentials. The ECS task
 * role must have no direct S3/KMS permission. */
export function createAwsQueuedRunRuntime(
  clients: { dynamo: DynamoDBDocumentClient; sqs: SQSClient },
  config: AwsQueuedRunConfiguration,
  grant: ScopedArtifactCredentials,
  application: CloudRunPorts["application"],
  receiptVerifier: CloudRunPorts["receiptVerifier"],
): { receiver: SqsApplicationQueueReceiver;
  handle(message: { body: string; receiptHandle: string }): Promise<CloudRunOutcome> } {
  if (!config.ledgerTable || !config.entitlementTable || !config.artifactBucket
    || !config.artifactKmsKeyArn || !config.applicationQueueUrl) {
    throw new Error("AWS application runtime configuration is incomplete");
  }
  const region = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\//.exec(config.artifactKmsKeyArn)?.[1];
  if (!region || !grant.candidateId || !grant.runId
    || !grant.accessKeyId || !grant.secretAccessKey || !grant.sessionToken
    || !Number.isFinite(Date.parse(grant.expiresAt))
    || Date.parse(grant.expiresAt) <= Date.now() + 60_000) {
    throw new Error("Scoped artifact credentials are unavailable");
  }
  const credentials = { accessKeyId: grant.accessKeyId,
    secretAccessKey: grant.secretAccessKey, sessionToken: grant.sessionToken };
  const kms = new KMSClient({ region, credentials });
  const s3 = new S3Client({ region, credentials });
  const admission = new DynamoHostedRunAdmission(clients.dynamo, config.ledgerTable);
  const receiver = new SqsApplicationQueueReceiver(clients.sqs, config.applicationQueueUrl);
  const innerVault = new CandidateVault(new KmsDataKeys(kms, config.artifactKmsKeyArn),
    new S3ArtifactStore(s3, config.artifactBucket));
  const vault: CloudRunPorts["vault"] = {
    restoreToPrivateTemp(candidateId, artifactId) {
      if (candidateId !== grant.candidateId) throw new Error("Artifact grant candidate mismatch");
      return innerVault.restoreToPrivateTemp(candidateId, artifactId);
    },
    put(candidateId, artifactId, bytes) {
      if (candidateId !== grant.candidateId) throw new Error("Artifact grant candidate mismatch");
      return innerVault.put(candidateId, artifactId, bytes);
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
    if (envelope.candidateId !== grant.candidateId || envelope.runId !== grant.runId) {
      throw new Error("Artifact grant run mismatch");
    }
    return handleQueuedApplication(message, ports);
  } };
}
