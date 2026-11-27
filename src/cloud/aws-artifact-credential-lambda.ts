import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { issueCandidateArtifactCredentials } from "./artifact-credential-broker.js";
import { DynamoArtifactGrantFence } from "./aws-artifact-grant-fence.js";

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
    return await issueCandidateArtifactCredentials(token, leaseToken, secret,
      Math.floor(Date.now() / 1000), {
        dataRoleArn: env.DATA_ROLE_ARN!, artifactBucket: env.ARTIFACT_BUCKET!,
        kmsKeyArn: env.ARTIFACT_KMS_KEY_ARN!,
      }, {
        admission: new DynamoHostedRunAdmission(dynamo, env.RUN_LEDGER_TABLE_NAME!),
        grantFence: new DynamoArtifactGrantFence(dynamo, env.RUN_LEDGER_TABLE_NAME!),
        billing: new DynamoCandidatePlanStatus(dynamo, env.ENTITLEMENT_TABLE_NAME!),
        clock: () => Math.floor(Date.now() / 1000),
        sts: new STSClient({}),
      });
  } finally { secret.fill(0); }
}
