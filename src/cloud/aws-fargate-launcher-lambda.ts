import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { SQSClient } from "@aws-sdk/client-sqs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { requireHostedAccess } from "../hosted/entitlement.js";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { SqsApplicationQueueSender } from "./aws-enqueue-ports.js";
import { DynamoApplicationDispatchStore, dispatchOnePendingApplication } from "./aws-durable-dispatch.js";
import { DynamoFargateLaunchStore, launchQueuedFargateRun, sweepFargateSlot,
  type FargateLaunchConfig } from "./fargate-launcher.js";

const eventSchema = z.strictObject({ candidateId: z.uuid(), runId: z.uuid() });
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function configFromEnv(): FargateLaunchConfig {
  if (required("FARGATE_LAUNCH_ENABLED") !== "true") throw new Error("Fargate launch disabled");
  return { enabled: true, environment: "staging", clusterArn: required("ECS_CLUSTER_ARN"),
    taskDefinitionArn: required("ECS_TASK_DEFINITION_ARN"),
    taskRoleArn: required("ECS_TASK_ROLE_ARN"),
    subnets: required("PRIVATE_SUBNET_IDS").split(","),
    securityGroupId: required("ECS_SECURITY_GROUP_ID"),
    containerName: required("ECS_CONTAINER_NAME"),
    queueUrl: required("APPLICATION_QUEUE_URL"),
    ledgerTable: required("RUN_LEDGER_TABLE_NAME") };
}

async function readSigningKey(): Promise<Buffer> {
  const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({
    SecretId: required("ARTIFACT_SIGNING_SECRET_ARN") }));
  if (!result.SecretString) throw new Error("Artifact signing secret unavailable");
  const secret = Buffer.from(result.SecretString, "base64");
  if (secret.toString("base64") !== result.SecretString || secret.length < 32) {
    secret.fill(0);
    throw new Error("Artifact signing secret malformed");
  }
  return secret;
}

function authorization(db: DynamoDBDocumentClient, ledger: string) {
  const admission = new DynamoHostedRunAdmission(db, ledger);
  const billing = new DynamoCandidatePlanStatus(db, required("ENTITLEMENT_TABLE_NAME"));
  return async (candidate: string, run: string) => {
    if (!await admission.hasCurrentConsent(candidate, run)) return false;
    const identity = await admission.loadIdentity(candidate, run);
    try { requireHostedAccess(identity.subjectId,
      await billing.loadEntitlements(identity.subjectId)); return true; }
    catch { return false; }
  };
}

function queuedAuthorization(db: DynamoDBDocumentClient, ledger: string,
  eligible = authorization(db, ledger)) {
  const dispatch = new DynamoApplicationDispatchStore(db, ledger);
  return async (candidateId: string, runId: string) => {
    const row = await dispatch.read(candidateId, runId);
    return (row?.state === "queued" || row?.state === "launched")
      && await eligible(candidateId, runId);
  };
}

/** Invoke only from the trusted enqueue Lambda after SendMessage succeeds.
 * Do not log event bodies or the broker signing key. */
export async function handler(event: unknown) {
  const config = configFromEnv();
  if ((event as { source?: unknown } | null)?.source === "aws.events") {
    return sweepHandler(config);
  }
  const { candidateId, runId } = eventSchema.parse(event);
  const ledger = required("RUN_LEDGER_TABLE_NAME");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const secret = await readSigningKey();
  try {
    return { status: await launchQueuedFargateRun(candidateId, runId, config, {
      store: new DynamoFargateLaunchStore(db, ledger), ecs: new ECSClient({}),
      signingKey: secret,
      authorize: queuedAuthorization(db, ledger),
    }) };
  } finally { secret.fill(0); }
}

/** EventBridge retries failures. Missing ECS state leaves the global slot
 * fenced; it never clears the reservation on a guess. */
async function sweepHandler(config: FargateLaunchConfig) {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const store = new DynamoFargateLaunchStore(db, config.ledgerTable);
  const ecs = new ECSClient({});
  const sweep = await sweepFargateSlot(config, { store, ecs });
  if (sweep === "waiting" || sweep === "stopping") return { status: sweep };
  const secret = await readSigningKey();
  try {
    const eligible = authorization(db, config.ledgerTable);
    const authorizeLaunch = queuedAuthorization(db, config.ledgerTable, eligible);
    const dispatch = await dispatchOnePendingApplication({
      store: new DynamoApplicationDispatchStore(db, config.ledgerTable),
      queue: new SqsApplicationQueueSender(new SQSClient({}), config.queueUrl),
      authorize: eligible,
      launch: (candidateId, runId) => launchQueuedFargateRun(candidateId, runId,
        config, { store, ecs, signingKey: secret, authorize: authorizeLaunch }),
    });
    return { status: sweep, dispatch };
  } finally { secret.fill(0); }
}
