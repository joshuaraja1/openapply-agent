import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { KMSClient } from "@aws-sdk/client-kms";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { KmsDataKeys, S3ArtifactStore } from "./aws-artifact-store.js";
import { SqsApplicationQueueReceiver } from "./aws-queue-consumer.js";
import { CandidateVault } from "./candidate-vault.js";
import { DurableApplicationJournal } from "./durable-journal.js";
import type { CloudRunPorts } from "./queued-run.js";

export interface AwsQueuedRunConfiguration {
  ledgerTable: string;
  entitlementTable: string;
  artifactBucket: string;
  artifactKmsKeyArn: string;
  applicationQueueUrl: string;
}

/** No browser adapter is supplied by this module. The caller must choose a
 * separately reviewed adapter and receipt verifier before a task can run. */
export function createAwsQueuedRunRuntime(
  clients: { dynamo: DynamoDBDocumentClient; kms: KMSClient; s3: S3Client; sqs: SQSClient },
  config: AwsQueuedRunConfiguration,
  application: CloudRunPorts["application"],
  receiptVerifier: CloudRunPorts["receiptVerifier"],
): { receiver: SqsApplicationQueueReceiver; ports: Omit<CloudRunPorts, "queue"> } {
  if (!config.ledgerTable || !config.entitlementTable || !config.artifactBucket
    || !config.artifactKmsKeyArn || !config.applicationQueueUrl) {
    throw new Error("AWS application runtime configuration is incomplete");
  }
  const admission = new DynamoHostedRunAdmission(clients.dynamo, config.ledgerTable);
  const receiver = new SqsApplicationQueueReceiver(clients.sqs, config.applicationQueueUrl);
  return { receiver, ports: {
    billing: new DynamoCandidatePlanStatus(clients.dynamo, config.entitlementTable),
    authorization: admission,
    runRecords: admission,
    journal: new DurableApplicationJournal(clients.dynamo, config.ledgerTable),
    vault: new CandidateVault(new KmsDataKeys(clients.kms, config.artifactKmsKeyArn),
      new S3ArtifactStore(clients.s3, config.artifactBucket)),
    application,
    receiptVerifier,
  } };
}
