import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { HostedAccessDeniedError, requireHostedAccess } from "../hosted/entitlement.js";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { DynamoApplicationDispatchStore, dispatchOnePendingApplication } from "./aws-durable-dispatch.js";
import { DurableApplicationJournal } from "./durable-journal.js";
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
  return { enabled: true, environment: "staging",
    maxConcurrentTasks: Number(required("FARGATE_MAX_CONCURRENT_TASKS")),
    clusterArn: required("ECS_CLUSTER_ARN"),
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

export async function confirmedHostedAccess(subjectId: string,
  loadEntitlements: (subjectId: string) => Promise<readonly unknown[]>): Promise<boolean> {
  const entitlements = await loadEntitlements(subjectId);
  try { requireHostedAccess(subjectId, entitlements); return true; }
  catch (error) {
    if (error instanceof HostedAccessDeniedError) return false;
    throw error;
  }
}

function authorization(db: DynamoDBDocumentClient, ledger: string) {
  const admission = new DynamoHostedRunAdmission(db, ledger);
  const billing = new DynamoCandidatePlanStatus(db, required("ENTITLEMENT_TABLE_NAME"));
  return async (candidate: string, run: string) => {
    if (!await admission.hasCurrentConsent(candidate, run)) return false;
    const identity = await admission.loadIdentity(candidate, run);
    return confirmedHostedAccess(identity.subjectId,
      (subjectId) => billing.loadEntitlements(subjectId));
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

/** EventBridge retries failures. Missing ECS state leaves its durable slot
 * fenced; it never clears the reservation on a guess. */
async function sweepHandler(config: FargateLaunchConfig) {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const store = new DynamoFargateLaunchStore(db, config.ledgerTable);
  const ecs = new ECSClient({});
  const activeSlots = await store.readActiveSlots(32);
  const sweep = await Promise.all(activeSlots.map(slot => sweepFargateSlot(config, { store, ecs,
    async onStopped(candidateId, runId, generation) {
      const outcome = await reconcileStoppedDispatch(candidateId, runId, generation, {
        dispatch: new DynamoApplicationDispatchStore(db, config.ledgerTable),
        admission: new DynamoHostedRunAdmission(db, config.ledgerTable),
        journal: new DurableApplicationJournal(db, config.ledgerTable),
      });
      return outcome === "retryable";
    },
  }, undefined, slot.index)));
  const secret = await readSigningKey();
  try {
    const eligible = authorization(db, config.ledgerTable);
    const authorizeLaunch = queuedAuthorization(db, config.ledgerTable, eligible);
    const dispatch: string[] = [];
    for (let index = 0; index < (config.maxConcurrentTasks ?? 1); index++) {
      const outcome = await dispatchOnePendingApplication({
        store: new DynamoApplicationDispatchStore(db, config.ledgerTable),
        authorize: eligible,
        launch: (candidateId, runId) => launchQueuedFargateRun(candidateId, runId,
          config, { store, ecs, signingKey: secret, authorize: authorizeLaunch }),
      });
      dispatch.push(outcome);
      if (outcome === "empty" || outcome === "capacity_busy") break;
    }
    return { status: sweep, dispatch };
  } finally { secret.fill(0); }
}

/** A stopped browser task cannot be relaunched with its old capability.
 * Repair a confirmed run; hold every other outcome for explicit review. */
export async function reconcileStoppedDispatch(candidateId: string, runId: string,
  generation: number, ports: {
  dispatch: Pick<DynamoApplicationDispatchStore, "read" | "markCompleted" | "markNeedsReconciliation">;
  admission: Pick<DynamoHostedRunAdmission, "loadIdentity">;
  journal: Pick<DurableApplicationJournal, "readSubmission">;
}): Promise<"absent" | "completed" | "preview_complete" | "needs_human" | "retryable" | "needs_reconciliation"> {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 2) {
    throw new Error("Invalid stopped launch generation");
  }
  const row = await ports.dispatch.read(candidateId, runId);
  if (!row) return "absent";
  if (row.state === "completed") return "completed";
  if (row.state === "preview_complete") return "preview_complete";
  if (row.state === "needs_human") return "needs_human";
  if (row.state === "needs_reconciliation" || row.state === "blocked") return "needs_reconciliation";
  const record = await ports.admission.loadIdentity(candidateId, runId);
  const submission = await ports.journal.readSubmission(candidateId, record.job);
  if (submission.status === "confirmed") {
    await ports.dispatch.markCompleted(candidateId, runId);
    return "completed";
  }
  if (submission.status === "not_started" && generation < 2) {
    return "retryable";
  }
  await ports.dispatch.markNeedsReconciliation(candidateId, runId);
  return "needs_reconciliation";
}
