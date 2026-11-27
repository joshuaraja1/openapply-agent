import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import Stripe from "stripe";
import { handleBillingSchedule, handleHttpApiEvent, type HttpApiEvent } from "./aws-lambda-adapter.js";
import { createHostedBillingRuntime } from "./billing-runtime.js";
import { DynamoBillingStore } from "./stripe-billing-store.js";
import { createOidcSubjectVerifier, type VerifySubject } from "./checkout-http.js";
import { handleApplicationEnqueueHttp } from "./application-enqueue-http.js";
import { DynamoHostedRunAdmission, SqsApplicationQueueSender } from "../cloud/aws-enqueue-ports.js";
import { DynamoApplicationDispatchStore } from "../cloud/aws-durable-dispatch.js";

type Environment = Record<string, string | undefined>;
type SecretReader = (arn: string) => Promise<string>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** Test-mode only. No live Stripe key can be accepted by this staging host. */
export async function loadStagingBillingConfig(env: Environment, readSecret: SecretReader) {
  if (required(env, "STRIPE_MODE") !== "test") throw new Error("Staging billing requires test mode");
  const [stripeKey, webhookSecret] = await Promise.all([
    readSecret(required(env, "STRIPE_TEST_SECRET_ARN")),
    readSecret(required(env, "STRIPE_WEBHOOK_SECRET_ARN")),
  ]);
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(stripeKey)
    || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
    throw new Error("Staging Stripe secret configuration is invalid");
  }
  const appOrigin = required(env, "APP_ORIGIN");
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Invalid staging app origin");
  }
  return {
    stripeKey,
    runtime: {
      tableName: required(env, "BILLING_TABLE_NAME"),
      entitlementTableName: required(env, "ENTITLEMENT_TABLE_NAME"),
      checkout: { prices: {
        monthly: { id: required(env, "MONTHLY_PRICE_ID"), amountCents: 3900 },
        semester: { id: required(env, "SEMESTER_PRICE_ID"), amountCents: 12900 },
      }, livemode: false, appOrigin },
      oidc: { issuer: required(env, "COGNITO_ISSUER"),
        audience: required(env, "COGNITO_CLIENT_ID"),
        jwksUrl: required(env, "COGNITO_JWKS_URL") },
      stripeWebhookSecret: webhookSecret,
    },
  };
}

const secrets = new SecretsManagerClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const lambda = new LambdaClient({});

/** A staging host must opt in with both resource names and explicit IAM.
 * The default deployment exposes no application enqueue route. */
export function createStagingApplicationQueuePorts(env: Environment,
  runDb: Pick<DynamoDBDocumentClient, "send">,
  queueClient: Pick<SQSClient, "send">) {
  if (env.ENQUEUE_ENABLED !== "true") return undefined;
  const ledger = required(env, "RUN_LEDGER_TABLE_NAME");
  const queueUrl = required(env, "APPLICATION_QUEUE_URL");
  const admission = new DynamoHostedRunAdmission(runDb, ledger);
  // The browser task no longer consumes shared SQS. Without the exact-run
  // launcher, an accepted HTTP request would strand the application.
  const launcherArn = required(env, "FARGATE_LAUNCHER_ARN");
  if (!/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:openapply-staging-fargate-launcher$/.test(launcherArn)) {
    throw new Error("Invalid Fargate launcher ARN");
  }
  return { runRecords: admission, authorization: admission,
    queue: new SqsApplicationQueueSender(queueClient, queueUrl),
    dispatch: new DynamoApplicationDispatchStore(runDb, ledger),
    launcher: { async launch(candidateId: string, runId: string) {
      const result = await lambda.send(new InvokeCommand({ FunctionName: launcherArn,
        InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify({ candidateId, runId })) }));
      if (result.StatusCode !== 200 || result.FunctionError || !result.Payload) {
        throw new Error("Fargate launch unavailable");
      }
      const response = JSON.parse(Buffer.from(result.Payload).toString("utf8")) as { status?: unknown };
      if (response.status !== "started" && response.status !== "capacity_busy"
        && response.status !== "already_stopped") {
        throw new Error("Fargate launch capacity unavailable");
      }
      return response.status;
    } },
  };
}
async function readSecret(arn: string): Promise<string> {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error("Hosted billing secret is unavailable");
  return result.SecretString.trim();
}

let runtimePromise: Promise<ReturnType<typeof createHostedBillingRuntime>> | undefined;
function runtime() {
  runtimePromise ??= (async () => {
    const config = await loadStagingBillingConfig(process.env, readSecret);
    return createHostedBillingRuntime(config.runtime, db, new Stripe(config.stripeKey));
  })().catch(error => { runtimePromise = undefined; throw error; });
  return runtimePromise;
}

/** Enqueue reads only the trusted entitlement projection and run ledger. Stripe
 * secrets are deliberately absent so a billing outage cannot block admission. */
export function createStagingEnqueueRuntime(env: Environment,
  runDb: Pick<DynamoDBDocumentClient, "send">,
  queueClient: Pick<SQSClient, "send">,
  verifySubject?: VerifySubject) {
  const ports = createStagingApplicationQueuePorts(env, runDb, queueClient);
  if (!ports) throw new Error("Application enqueue disabled");
  const appOrigin = required(env, "APP_ORIGIN");
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Invalid staging app origin");
  }
  const subjectVerifier = verifySubject ?? createOidcSubjectVerifier({
    issuer: required(env, "COGNITO_ISSUER"), audience: required(env, "COGNITO_CLIENT_ID"),
    jwksUrl: required(env, "COGNITO_JWKS_URL"),
  });
  const billing = new DynamoBillingStore(runDb, required(env, "BILLING_TABLE_NAME"),
    required(env, "ENTITLEMENT_TABLE_NAME"));
  return {
    handleRequest: (request: Request) => handleApplicationEnqueueHttp(request, {
      appOrigin, verifySubject: subjectVerifier, ports: { ...ports, billing },
    }),
    processReady: async () => ({ processed: 0, deferred: 0 }),
  };
}

let enqueueRuntime: ReturnType<typeof createStagingEnqueueRuntime> | undefined;

/** Keep the application route out of the Stripe initialization path. */
export function selectStagingHttpRuntime<T>(event: HttpApiEvent,
  billingRuntime: () => T | Promise<T>, applicationRuntime: () => T | Promise<T>): T | Promise<T> {
  return event.rawPath === "/api/applications/enqueue" ? applicationRuntime() : billingRuntime();
}

/** API Gateway HTTP API v2 route handler. No secrets or request body are logged. */
export async function handler(event: HttpApiEvent) {
  try {
    const app = await selectStagingHttpRuntime(event, runtime,
      () => enqueueRuntime ??= createStagingEnqueueRuntime(process.env, db, sqs));
    return await handleHttpApiEvent(event, app, required(process.env, "APP_ORIGIN"));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "HTTP API body is too large";
    return { statusCode: tooLarge ? 413 : 503,
      headers: { "cache-control": "no-store" }, body: "", isBase64Encoded: true as const };
  }
}

/** EventBridge invokes this separately; failures are retried by AWS. */
export async function scheduledHandler() {
  return handleBillingSchedule(await runtime());
}
