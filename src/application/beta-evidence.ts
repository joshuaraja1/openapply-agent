import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApplicationStateStore } from "../storage/contracts.js";
import type { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import type { ApplicationCheckpoint } from "./state-machine.js";

const alias = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const provider = z.enum(["greenhouse", "ashby", "lever", "smartrecruiters", "workday", "other"]);
const ms = z.number().int().nonnegative().max(86_400_000);
export const betaConsentSchema = z.strictObject({
  kind: z.literal("consent"), participantId: alias,
  approvedProviders: z.array(provider).min(1), dailyCap: z.number().int().positive().max(100),
  automaticSubmission: z.boolean(), monitoringAccepted: z.literal(true),
  browserSessionApproved: z.literal(true), candidateAcknowledged: z.literal(true),
  retentionDays: z.number().int().positive().max(365),
});
export const betaObservationSchema = z.strictObject({
  kind: z.literal("observation"), participantId: alias, runId: alias, jobId: z.string().min(1).max(200),
  provider, os: z.enum(["macos", "windows", "linux"]),
  outcome: z.enum(["submitted", "waiting-human", "submission-uncertain", "blocked", "skipped"]),
  failureCategory: z.enum(["none", "browser", "provider-form", "upload", "auth", "human-question", "confirmation", "other"]),
  retryCount: z.number().int().nonnegative().max(100), crashCount: z.number().int().nonnegative().max(100),
  stageLatencyMs: z.partialRecord(z.enum(["discovery", "matching", "render", "application", "recovery"]), ms),
});
export type BetaConsent = z.infer<typeof betaConsentSchema> & { recordedAt: string; withdrawnAt?: string };
export type BetaObservationInput = z.infer<typeof betaObservationSchema>;
export interface BetaObservation extends BetaObservationInput {
  recordedAt: string;
  officialUrlSha256: string;
  confirmationPresent: boolean;
  checkpointStage: ApplicationCheckpoint["stage"];
  checkpointUpdatedAt: string;
}
/** Minimal marker prevents a withdrawn alias from silently re-enrolling after retention cleanup. */
export interface BetaRevocation { kind: "revocation"; participantId: string; withdrawnAt: string }
export type BetaEvidence = BetaConsent | BetaObservation | BetaRevocation;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const consentKey = (id: string) => `consent:${id}`;
const observationKey = (participant: string, run: string, job: string) =>
  `observation:${participant}:${run}:${digest(job)}`;

function checkpointProvider(checkpoint: ApplicationCheckpoint): z.infer<typeof provider> {
  let host: string;
  try { host = new URL(checkpoint.officialUrl).hostname.toLowerCase(); }
  catch { throw new Error("Application checkpoint has an invalid official URL"); }
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") return "greenhouse";
  if (host === "jobs.ashbyhq.com") return "ashby";
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return "lever";
  if (host === "jobs.smartrecruiters.com") return "smartrecruiters";
  if (host.endsWith(".myworkdayjobs.com") || host === "myworkdayjobs.com") return "workday";
  return "other";
}

export async function recordConsent(store: ApplicationStateStore<BetaEvidence>, raw: unknown,
  now = new Date()): Promise<BetaConsent> {
  const input = betaConsentSchema.parse(raw);
  const key = consentKey(input.participantId);
  const record: BetaConsent = { ...input, recordedAt: now.toISOString() };
  if (!await store.compareAndSwap(key, undefined, record)) throw new Error("Beta consent already exists");
  return record;
}

export async function withdrawConsent(store: ApplicationStateStore<BetaEvidence>, participantId: string,
  now = new Date()): Promise<BetaRevocation> {
  const key = consentKey(alias.parse(participantId));
  const prior = await store.read(key);
  if (!prior || prior.state.kind !== "consent" || prior.state.withdrawnAt) {
    throw new Error("Active beta consent is required for withdrawal");
  }
  const withdrawnAt = now.toISOString();
  if (withdrawnAt < prior.state.recordedAt) throw new Error("Withdrawal predates consent");
  const record: BetaRevocation = { kind: "revocation", participantId, withdrawnAt };
  if (!await store.compareAndSwap(key, prior.version, record)) throw new Error("Beta consent changed concurrently");
  return record;
}

/** Remove expired observations and withdrawn participants' observations from the private ledger. */
export async function sweepBetaEvidence(store: EncryptedApplicationStateStore<BetaEvidence>,
  now = new Date()): Promise<number> {
  const records = await store.snapshotRecords();
  const consents = new Map(records.flatMap((row) => row.state?.kind === "consent"
    ? [[row.state.participantId, row.state] as const] : []));
  let removed = 0;
  for (const row of records) {
    const item = row.state;
    if (!item || item.kind !== "observation") continue;
    const consent = consents.get(item.participantId);
    const expired = !consent || Boolean(consent.withdrawnAt)
      || now.getTime() >= new Date(item.recordedAt).getTime() + consent.retentionDays * 86_400_000
      || now.getTime() >= new Date(consent.recordedAt).getTime() + consent.retentionDays * 86_400_000;
    if (expired && await store.delete(row.id, row.version)) removed++;
  }
  for (const row of records) {
    const item = row.state;
    if (item?.kind === "consent" && now.getTime() >= Date.parse(item.recordedAt) + item.retentionDays * 86_400_000
      && await store.delete(row.id, row.version)) removed++;
  }
  return removed;
}

export async function recordObservation(store: ApplicationStateStore<BetaEvidence>, raw: unknown,
  checkpoint: ApplicationCheckpoint, now = new Date()): Promise<BetaObservation> {
  const input = betaObservationSchema.parse(raw);
  const recordedAt = now.toISOString();
  const saved = (await store.read(consentKey(input.participantId)))?.state;
  if (!saved || saved.kind !== "consent" || saved.withdrawnAt || !saved.approvedProviders.includes(input.provider)
    || recordedAt < saved.recordedAt
    || now.getTime() >= Date.parse(saved.recordedAt) + saved.retentionDays * 86_400_000) {
    throw new Error("Active beta consent does not cover this provider or time");
  }
  if (input.jobId !== checkpoint.jobId || !checkpoint.officialUrl) {
    throw new Error("Beta observation does not match the exact application checkpoint");
  }
  if (recordedAt < checkpoint.updatedAt) {
    throw new Error("Beta observation predates the saved application checkpoint");
  }
  if (!checkpoint.createdAt || checkpoint.createdAt < saved.recordedAt) {
    throw new Error("Application began before beta consent or has no trusted creation time");
  }
  const actualProvider = checkpointProvider(checkpoint);
  if (input.provider !== actualProvider || (checkpoint.jobId.includes(":")
    && checkpoint.jobId.split(":", 1)[0] !== (actualProvider === "other" ? "jsonld" : actualProvider))) {
    throw new Error("Beta provider does not match the saved official posting");
  }
  if (input.outcome === "submitted" && (checkpoint.stage !== "submitted"
    || !checkpoint.confirmation?.trim())) {
    throw new Error("Submitted beta evidence requires a confirmed job-bound checkpoint and consent");
  }
  if (input.outcome !== "submitted" && input.outcome !== checkpoint.stage) {
    throw new Error("Beta outcome must match the saved application checkpoint");
  }
  const record: BetaObservation = { ...input, recordedAt, officialUrlSha256: digest(checkpoint.officialUrl),
    confirmationPresent: checkpoint.stage === "submitted" && Boolean(checkpoint.confirmation?.trim()),
    checkpointStage: checkpoint.stage, checkpointUpdatedAt: checkpoint.updatedAt };
  const key = observationKey(input.participantId, input.runId, input.jobId);
  if (!await store.compareAndSwap(key, undefined, record)) {
    throw new Error("Beta observation for this run and exact job already exists");
  }
  return record;
}

export function summarizeBetaEvidence(records: BetaEvidence[]) {
  const observations = records.filter((item): item is BetaObservation => item.kind === "observation");
  const counts: Record<string, { total: number; confirmed: number; handoffs: number; uncertain: number;
    crashes: number; retries: number; failures: Record<string, number>;
    latencyMs: Record<string, { samples: number; median: number; p95: number }> }> = {};
  const samples: Record<string, Record<string, number[]>> = {};
  for (const row of observations) {
    const entry = counts[row.provider] ??= { total: 0, confirmed: 0, handoffs: 0, uncertain: 0,
      crashes: 0, retries: 0, failures: {}, latencyMs: {} };
    entry.total++;
    if (row.outcome === "submitted" && row.confirmationPresent) entry.confirmed++;
    if (row.outcome === "waiting-human") entry.handoffs++;
    if (row.outcome === "submission-uncertain") entry.uncertain++;
    entry.crashes += row.crashCount;
    entry.retries += row.retryCount;
    if (row.failureCategory !== "none") entry.failures[row.failureCategory] = (entry.failures[row.failureCategory] ?? 0) + 1;
    for (const [stage, duration] of Object.entries(row.stageLatencyMs)) {
      (samples[row.provider] ??= {})[stage] ??= [];
      samples[row.provider]![stage]!.push(duration);
    }
  }
  for (const [name, stages] of Object.entries(samples)) {
    for (const [stage, values] of Object.entries(stages)) {
      values.sort((a, b) => a - b);
      counts[name]!.latencyMs[stage] = { samples: values.length,
        median: values[Math.ceil(values.length * 0.5) - 1]!,
        p95: values[Math.ceil(values.length * 0.95) - 1]! };
    }
  }
  return { providerCounts: counts, observations: observations.length };
}
