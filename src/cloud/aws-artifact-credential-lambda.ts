import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { issueCandidateArtifactCredentials, storeEncryptedReceipt } from "./artifact-credential-broker.js";
import { DynamoArtifactGrantFence } from "./aws-artifact-grant-fence.js";
import { S3ArtifactStore } from "./aws-artifact-store.js";

const env = process.env;
const required = ["ARTIFACT_SIGNING_SECRET_ARN", "DATA_ROLE_ARN", "ARTIFACT_BUCKET",
  "ARTIFACT_KMS_KEY_ARN", "RUN_LEDGER_TABLE_NAME", "ENTITLEMENT_TABLE_NAME"] as const;

/** Direct Lambda invocation is allowed only to the task role. The task also
 * presents a launcher-minted, per-run capability; no candidate ID is trusted
 * from the event body. Never log this event or returned STS credentials. */
export async function handler(event: unknown) {
  for (const key of required) if (!env[key]) throw new Error("Artifact broker is not configured");
  const token = (event as { capability?: unknown } | null)?.capability;
  const leaseToken = (event as { leaseToken?: unknown } | null)?.leaseToken;
  const kind = (event as { kind?: unknown } | null)?.kind;
  if (typeof token !== "string" || token.length > 800
    || typeof leaseToken !== "string") {
    throw new Error("Task capability unavailable");
  }
  const secrets = new SecretsManagerClient({});
  const result = await secrets.send(new GetSecretValueCommand({
    SecretId: env.ARTIFACT_SIGNING_SECRET_ARN!, }));
  if (!result.SecretString) throw new Error("Artifact broker signing key is unavailable");
  const secret = Buffer.from(result.SecretString, "base64");
  if (secret.toString("base64") !== result.SecretString) {
    throw new Error("Artifact broker signing key is malformed");
  }
  try {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const nowEpoch = Math.floor(Date.now() / 1000);
    const config = {
        dataRoleArn: env.DATA_ROLE_ARN!, artifactBucket: env.ARTIFACT_BUCKET!,
        kmsKeyArn: env.ARTIFACT_KMS_KEY_ARN!,
    };
    const admission = new DynamoHostedRunAdmission(dynamo, env.RUN_LEDGER_TABLE_NAME!);
    const grantFence = new DynamoArtifactGrantFence(dynamo, env.RUN_LEDGER_TABLE_NAME!);
    const billing = new DynamoCandidatePlanStatus(dynamo, env.ENTITLEMENT_TABLE_NAME!);
    if (kind === "receipt-upload") {
      const artifactId = (event as { artifactId?: unknown }).artifactId;
      const encoded = (event as { bodyBase64?: unknown }).bodyBase64;
      if (typeof artifactId !== "string" || typeof encoded !== "string"
        || encoded.length > 2_200_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new Error("Receipt envelope unavailable");
      }
      const body = Buffer.from(encoded, "base64");
      if (body.toString("base64") !== encoded) throw new Error("Receipt envelope unavailable");
      try {
        return await storeEncryptedReceipt(token, leaseToken, artifactId, body,
          secret, nowEpoch, config, { admission, grantFence, billing,
            clock: () => Math.floor(Date.now() / 1000),
            receipts: new S3ArtifactStore(new S3Client({}), env.ARTIFACT_BUCKET!) });
      } finally { body.fill(0); }
    }
    if (kind !== "credentials") throw new Error("Unknown artifact broker request");
    return await issueCandidateArtifactCredentials(token, leaseToken, secret,
      nowEpoch, config, { admission, grantFence, billing,
        clock: () => Math.floor(Date.now() / 1000), sts: new STSClient({}) });
  } finally { secret.fill(0); }
}
