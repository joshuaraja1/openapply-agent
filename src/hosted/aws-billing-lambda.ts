import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import { handleBillingSchedule, handleHttpApiEvent, type HttpApiEvent } from "./aws-lambda-adapter.js";
import { createHostedBillingRuntime } from "./billing-runtime.js";

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

/** API Gateway HTTP API v2 route handler. No secrets or request body are logged. */
export async function handler(event: HttpApiEvent) {
  try {
    const app = await runtime();
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
