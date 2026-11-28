import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand }
  from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { KmsDataKeys, S3ArtifactStore } from "./aws-artifact-store.js";
import { CandidateVault } from "./candidate-vault.js";
import { DynamoApplicationDispatchStore } from "./aws-durable-dispatch.js";
import { DynamoHostedRunAdmission } from "./aws-enqueue-ports.js";
import { DynamoTrustedRunCreator } from "./aws-run-creator-ports.js";
import { officialJobKey } from "./durable-journal.js";
import { candidateIdForSubject, createTrustedApplicationRun } from "./hosted-run-creator.js";
import { enqueueHostedApplication } from "./paid-enqueue.js";
import { DynamoCandidatePlanStatus } from "../hosted/aws-plan-status.js";

const ACCOUNT = "205064803661";
const REGION = "us-east-1";
const LEDGER = "openapply-staging-run-ledger";
const ENTITLEMENTS = "openapply-staging-entitlements";
const STACKS = { cognito: "openapply-staging-cognito",
  control: "openapply-staging-control-plane", onboarding: "openapply-staging-onboarding" };

interface FixtureRun { runId: string; leadId: string; requisitionId: string }
interface FixtureSeeker { subjectId: string; candidateId: string; profileArtifactId: string;
  grantId: string; runs: FixtureRun[] }
export interface FixtureManifest { version: 1; accountId: string; region: string;
  issuer: string; createdAt: string; expiresAt: string; seekers: [FixtureSeeker, FixtureSeeker] }

export function createFixtureManifest(issuer: string, now = new Date(), id = randomUUID): FixtureManifest {
  if (!/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_[A-Za-z0-9]+$/.test(issuer)) {
    throw new Error("Staging Cognito issuer is unavailable");
  }
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 90 * 60_000).toISOString();
  const seeker = (count: number): FixtureSeeker => {
    const subjectId = `synthetic-drill-${id()}`;
    const candidateId = candidateIdForSubject(issuer, subjectId);
    return { subjectId, candidateId, profileArtifactId: id(), grantId: id(),
      runs: Array.from({ length: count }, () => {
        const runId = id();
        return { runId, leadId: id(), requisitionId: `drill-${runId}` };
      }) };
  };
  return { version: 1, accountId: ACCOUNT, region: REGION, issuer,
    createdAt, expiresAt, seekers: [seeker(2), seeker(1)] };
}

export function validateManifest(value: FixtureManifest, issuer: string): FixtureManifest {
  const id = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const created = Date.parse(value?.createdAt);
  const expires = Date.parse(value?.expiresAt);
  if (value?.version !== 1 || value.accountId !== ACCOUNT || value.region !== REGION
    || value.issuer !== issuer || !Array.isArray(value.seekers) || value.seekers.length !== 2
    || value.seekers[0]?.runs.length !== 2 || value.seekers[1]?.runs.length !== 1
    || value.seekers.some(seeker => !seeker.subjectId.startsWith("synthetic-drill-")
      || !id.test(seeker.subjectId.slice("synthetic-drill-".length))
      || seeker.candidateId !== candidateIdForSubject(issuer, seeker.subjectId)
      || !id.test(seeker.profileArtifactId) || !id.test(seeker.grantId)
      || seeker.runs.some(run => !id.test(run.runId) || !id.test(run.leadId)
        || run.requisitionId !== `drill-${run.runId}`))
    || new Set(value.seekers.map(seeker => seeker.candidateId)).size !== 2
    || !Number.isFinite(created) || !Number.isFinite(expires)
    || expires - created !== 90 * 60_000) {
    throw new Error("Disposable fixture manifest is invalid");
  }
  return value;
}

async function resources() {
  const identity = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== ACCOUNT) throw new Error("AWS account mismatch");
  const stack = async (name: string): Promise<{ Outputs?: { OutputKey?: string; OutputValue?: string }[] }> => {
    const json = execFileSync("aws", ["cloudformation", "describe-stacks", "--stack-name", name,
      "--region", REGION, "--output", "json"], { encoding: "utf8", timeout: 20_000 });
    return (JSON.parse(json) as { Stacks?: { Outputs?: { OutputKey?: string; OutputValue?: string }[] }[] })
      .Stacks?.[0] ?? {};
  };
  const [cognito, control, onboarding] = await Promise.all([
    stack(STACKS.cognito), stack(STACKS.control), stack(STACKS.onboarding),
  ]);
  const output = (value: typeof cognito, name: string) =>
    value?.Outputs?.find(item => item.OutputKey === name)?.OutputValue;
  const issuer = output(cognito, "Issuer");
  const bucket = output(control, "PrivateArtifactsBucket");
  const keyArn = output(onboarding, "CandidateDataKeyArn");
  if (!issuer || !bucket || !keyArn || !keyArn.includes(`:${REGION}:${ACCOUNT}:`)) {
    throw new Error("Staging fixture resources are unavailable");
  }
  return { issuer, bucket, keyArn };
}

function preflight() {
  execFileSync("node", ["scripts/aws-synthetic-drill-preflight.mjs", "--account-id", ACCOUNT],
    { stdio: "inherit", timeout: 30_000 });
}

function clients(bucket: string, keyArn: string) {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const objects = new S3ArtifactStore(new S3Client({ region: REGION }), bucket);
  const vault = new CandidateVault(new KmsDataKeys(new KMSClient({ region: REGION }), keyArn), objects);
  return { db, objects, vault };
}

async function seed(manifestPath: string) {
  preflight();
  const { issuer, bucket, keyArn } = await resources();
  const manifest = createFixtureManifest(issuer);
  // Write opaque identifiers before cloud mutation so interrupted seeding can
  // always be cleaned up with the same manifest. No browser cookies or keys.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  const { db, vault } = clients(bucket, keyArn);
  const creator = new DynamoTrustedRunCreator(db, new S3Client({ region: REGION }), LEDGER, bucket);
  const billing = new DynamoCandidatePlanStatus(db, ENTITLEMENTS);
  try {
  for (const seeker of manifest.seekers) {
    await db.send(new PutCommand({ TableName: ENTITLEMENTS,
      Item: { pk: `SUBJECT#${seeker.subjectId}`, sk: `ENTITLEMENT#${seeker.grantId}`,
        record: { kind: "free-grant", subjectId: seeker.subjectId, grantId: seeker.grantId,
          approvedBy: "staging-synthetic-drill", startsAt: manifest.createdAt,
          endsAt: manifest.expiresAt, revokedAt: null } },
      ConditionExpression: "attribute_not_exists(pk)" }));
    const profile = Buffer.from(JSON.stringify({ version: 1,
      provenance: "candidate-entered-and-reviewed", candidateId: seeker.candidateId,
      workAuthorization: "Synthetic fixture authorization", sponsorshipRequiredNowOrFuture: false,
      consent: { storage: true, automation: true, reviewed: true } }));
    try { await vault.put(seeker.candidateId, seeker.profileArtifactId, profile); }
    finally { profile.fill(0); }
    await db.send(new PutCommand({ TableName: LEDGER,
      Item: { pk: `CANDIDATE#${seeker.candidateId}`,
        sk: `PROFILE#${seeker.profileArtifactId}`, status: "verified",
        candidateId: seeker.candidateId, artifactId: seeker.profileArtifactId,
        subjectId: seeker.subjectId, applicationProfileReady: true },
      ConditionExpression: "attribute_not_exists(pk)" }));
    for (const run of seeker.runs) {
      const job = { provider: "synthetic", employerId: "fixture", requisitionId: run.requisitionId };
      const lead = { pk: `LEAD#${run.leadId}`, sk: "VERIFIED", status: "open",
        leadId: run.leadId, job, jobKey: officialJobKey(job),
        canonicalUrl: `https://fixture.openapply.invalid/apply/${run.requisitionId}`,
        expiresAt: Math.floor(Date.parse(manifest.expiresAt) / 1000) };
      await db.send(new PutCommand({ TableName: LEDGER, Item: lead,
        ConditionExpression: "attribute_not_exists(pk)" }));
      await createTrustedApplicationRun(issuer, seeker.subjectId,
        { runId: run.runId, leadId: run.leadId, profileArtifactId: seeker.profileArtifactId,
          consent: { granted: true, scope: "apply-one-job", policyVersion: "v1" } },
        { billing, loadLead: id => creator.loadLead(id),
          loadProfile: (candidate, artifact) => creator.loadProfile(candidate, artifact),
          profileObjectExists: (candidate, artifact) => creator.profileObjectExists(candidate, artifact),
          createOrGet: (record, verifiedLead, nowEpoch) => creator.createOrGet(record, verifiedLead, nowEpoch) });
    }
  }
  } catch (error) {
    try { await cleanupFixture(manifest, db, vault); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `Fixture seed failed and automatic cleanup is incomplete; retain manifest ${manifestPath}`);
    }
    throw error;
  }
  process.stdout.write(`Prepared 2 fake job seekers and 3 runs; no browser task enqueued. Manifest: ${manifestPath}\n`);
}

async function enqueue(manifestPath: string) {
  preflight();
  const { issuer } = await resources();
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest, issuer);
  if (Date.now() >= Date.parse(manifest.expiresAt)) throw new Error("Fixture grant has expired");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const admission = new DynamoHostedRunAdmission(db, LEDGER);
  const billing = new DynamoCandidatePlanStatus(db, ENTITLEMENTS);
  const dispatch = new DynamoApplicationDispatchStore(db, LEDGER);
  for (const seeker of manifest.seekers) for (const run of seeker.runs) {
    if (!await admission.ownsRun(seeker.candidateId, run.runId)
      || !await admission.hasCurrentConsent(seeker.candidateId, run.runId)
      || (await admission.loadIdentity(seeker.candidateId, run.runId)).subjectId !== seeker.subjectId
      || (await billing.loadEntitlements(seeker.subjectId)).length !== 1) {
      throw new Error("Fixture run is not fully prepared");
    }
  }
  try {
  // Enqueue A1, A2, then B1. The scheduled launcher owns the actual ECS start.
  for (const seeker of manifest.seekers) for (const run of seeker.runs) {
    await enqueueHostedApplication(seeker.subjectId, seeker.candidateId, run.runId,
      { runRecords: admission, authorization: admission, billing, dispatch,
        queue: { async send() { throw new Error("Synthetic fixture cannot send shared SQS messages"); } } });
  }
  } catch (error) {
    try { await fenceFixture(manifest, db); }
    catch (fenceError) {
      throw new AggregateError([error, fenceError],
        `Fixture enqueue failed and deletion fencing is incomplete; retain manifest ${manifestPath}`);
    }
    throw new Error(`Fixture enqueue failed; both seekers fenced. Stop tasks and clean up with ${manifestPath}`,
      { cause: error });
  }
  process.stdout.write(`Enqueued 3 exact synthetic runs for 2 fake job seekers. Manifest: ${manifestPath}\n`);
}

export async function fenceFixture(manifest: FixtureManifest,
  db: Pick<DynamoDBDocumentClient, "send">): Promise<void> {
  for (const seeker of manifest.seekers) {
    await db.send(new PutCommand({ TableName: LEDGER,
      Item: { pk: `CANDIDATE#${seeker.candidateId}`, sk: "DELETED",
        requestedAt: new Date().toISOString(), syntheticDrill: true },
      ConditionExpression: "attribute_not_exists(pk)" })).catch(error => {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
    });
  }
}

export async function cleanupFixture(manifest: FixtureManifest,
  db: Pick<DynamoDBDocumentClient, "send">,
  vault: Pick<CandidateVault, "deleteCandidate">): Promise<void> {
  // Fence new launches first. If a task is still active, preserve all data and
  // rerun cleanup only after ECS reports STOPPED and the sweep frees its lock.
  await fenceFixture(manifest, db);
  for (const seeker of manifest.seekers) {
    const active = await db.send(new GetCommand({ TableName: LEDGER,
      Key: { pk: `CANDIDATE#${seeker.candidateId}`, sk: "ACTIVE_TASK" }, ConsistentRead: true }));
    if (active.Item) throw new Error("Synthetic browser task is still active; wait for ECS STOPPED");
  }
  for (const slot of [0, 1]) {
    const occupied = await db.send(new GetCommand({ TableName: LEDGER,
      Key: { pk: "LAUNCHER#staging", sk: `SLOT#${slot}` }, ConsistentRead: true }));
    if (occupied.Item) throw new Error("Launcher slot is still reserved; wait for stopped-task reconciliation");
  }
  for (const seeker of manifest.seekers) {
    const allowed = new Set(["DELETED", "LEASE", `PROFILE#${seeker.profileArtifactId}`,
      ...seeker.runs.flatMap(run => [
        `RUN#${run.runId}`, `CONSENT#${run.runId}`, `DISPATCH#${run.runId}`,
        `TASK#${run.runId}`, officialJobKey({ provider: "synthetic", employerId: "fixture",
          requisitionId: run.requisitionId }),
      ])]);
    const candidateRows: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(new QueryCommand({ TableName: LEDGER,
        KeyConditionExpression: "pk=:pk", ExpressionAttributeValues: { ":pk": `CANDIDATE#${seeker.candidateId}` },
        ConsistentRead: true, Limit: 100, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const row of page.Items ?? []) {
        if (row.pk !== `CANDIDATE#${seeker.candidateId}` || typeof row.sk !== "string"
          || (!allowed.has(row.sk) && !/^GRANT#[a-f0-9-]{36}$/.test(row.sk))) {
          throw new Error("Unexpected row in disposable fixture partition; manual review required");
        }
        if (row.sk === "DELETED" && row.syntheticDrill !== true
          || row.sk === `PROFILE#${seeker.profileArtifactId}`
            && (row.candidateId !== seeker.candidateId
              || row.artifactId !== seeker.profileArtifactId
              || row.subjectId !== seeker.subjectId)
          || row.sk.startsWith("RUN#") && !seeker.runs.some(run => row.sk === `RUN#${run.runId}`
            && row.runId === run.runId && row.candidateId === seeker.candidateId
            && row.subjectId === seeker.subjectId && row.job?.provider === "synthetic"
            && row.job?.employerId === "fixture" && row.job?.requisitionId === run.requisitionId)
          || row.sk.startsWith("CONSENT#") && !seeker.runs.some(run =>
            row.sk === `CONSENT#${run.runId}` && row.runId === run.runId)
          || row.sk.startsWith("DISPATCH#") && !seeker.runs.some(run =>
            row.sk === `DISPATCH#${run.runId}` && row.runId === run.runId
              && row.candidateId === seeker.candidateId)
          || row.sk.startsWith("TASK#") && !seeker.runs.some(run =>
            row.sk === `TASK#${run.runId}` && row.runId === run.runId
              && row.candidateId === seeker.candidateId)) {
          throw new Error("Fixture row provenance changed; manual review required");
        }
        candidateRows.push(row);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    for (const run of seeker.runs) {
      const row = await db.send(new GetCommand({ TableName: LEDGER,
        Key: { pk: `LEAD#${run.leadId}`, sk: "VERIFIED" }, ConsistentRead: true }));
      if (row.Item && (row.Item.job?.provider !== "synthetic"
        || row.Item.job?.employerId !== "fixture"
        || row.Item.job?.requisitionId !== run.requisitionId)) {
        throw new Error("Fixture lead changed; manual review required");
      }
    }
    const grant = await db.send(new GetCommand({ TableName: ENTITLEMENTS,
      Key: { pk: `SUBJECT#${seeker.subjectId}`, sk: `ENTITLEMENT#${seeker.grantId}` },
      ConsistentRead: true }));
    if (grant.Item && (grant.Item.record?.subjectId !== seeker.subjectId
      || grant.Item.record?.grantId !== seeker.grantId
      || grant.Item.record?.approvedBy !== "staging-synthetic-drill")) {
      throw new Error("Fixture grant changed; manual review required");
    }
    await vault.deleteCandidate(seeker.candidateId);
    for (const row of candidateRows) if (row.sk !== "DELETED") {
      await db.send(new DeleteCommand({ TableName: LEDGER,
        Key: { pk: row.pk, sk: row.sk } }));
    }
    await db.send(new DeleteCommand({ TableName: ENTITLEMENTS,
      Key: { pk: `SUBJECT#${seeker.subjectId}`, sk: `ENTITLEMENT#${seeker.grantId}` } }));
    for (const run of seeker.runs) await db.send(new DeleteCommand({ TableName: LEDGER,
      Key: { pk: `LEAD#${run.leadId}`, sk: "VERIFIED" } }));
  }
  process.stdout.write("Disposable fixture artifacts and records removed; deletion fences retained.\n");
}

async function cleanup(manifestPath: string) {
  const { issuer, bucket, keyArn } = await resources();
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest, issuer);
  for (const status of ["PENDING", "RUNNING"]) {
    const tasks = JSON.parse(execFileSync("aws", ["ecs", "list-tasks", "--cluster",
      "openapply-staging-browser", "--desired-status", status, "--region", REGION,
      "--output", "json"], { encoding: "utf8", timeout: 20_000 })) as { taskArns?: string[] };
    if (tasks.taskArns?.length) throw new Error(`ECS still has ${status.toLowerCase()} browser tasks`);
  }
  const { db, vault } = clients(bucket, keyArn);
  await cleanupFixture(manifest, db, vault);
}

async function main(args: string[]) {
  const [command, manifestPath, accountId] = args;
  if ((command !== "seed" && command !== "enqueue" && command !== "cleanup") || !manifestPath
    || !isAbsolute(manifestPath) || accountId !== ACCOUNT) {
    throw new Error("Usage: tsx src/cloud/aws-synthetic-drill-fixture-cli.ts seed|enqueue|cleanup /absolute/manifest.json 205064803661");
  }
  if (command === "seed") await seed(manifestPath);
  else if (command === "enqueue") await enqueue(manifestPath);
  else await cleanup(manifestPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Synthetic fixture failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = 1;
  });
}
