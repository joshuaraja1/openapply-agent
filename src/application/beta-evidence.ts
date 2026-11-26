import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ApplicationStateStore } from "../storage/contracts.js";
import type { ApplicationCheckpoint } from "./state-machine.js";

const alias = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const provider = z.enum(["greenhouse", "ashby", "lever", "smartrecruiters", "workday", "other"]);
const ms = z.number().int().nonnegative().max(86_400_000);
export const betaConsentSchema = z.strictObject({
  kind: z.literal("consent"), participantId: alias, recordedAt: z.iso.datetime(),
  approvedProviders: z.array(provider).min(1), dailyCap: z.number().int().positive().max(100),
  automaticSubmission: z.boolean(), monitoringAccepted: z.literal(true),
  browserSessionApproved: z.literal(true), candidateAcknowledged: z.literal(true),
  retentionDays: z.number().int().positive().max(365),
  withdrawnAt: z.iso.datetime().optional(),
});
export const betaObservationSchema = z.strictObject({
  kind: z.literal("observation"), participantId: alias, runId: alias, jobId: z.string().min(1).max(200),
  provider, os: z.enum(["macos", "windows", "linux"]), recordedAt: z.iso.datetime(),
  outcome: z.enum(["submitted", "waiting-human", "submission-uncertain", "blocked", "skipped"]),
  failureCategory: z.enum(["none", "browser", "provider-form", "upload", "auth", "human-question", "confirmation", "other"]),
  retryCount: z.number().int().nonnegative().max(100), crashCount: z.number().int().nonnegative().max(100),
  stageLatencyMs: z.partialRecord(z.enum(["discovery", "matching", "render", "application", "recovery"]), ms),
});
export type BetaConsent = z.infer<typeof betaConsentSchema>;
export type BetaObservationInput = z.infer<typeof betaObservationSchema>;
export interface BetaObservation extends BetaObservationInput {
  officialUrlSha256: string;
  confirmationPresent: boolean;
  checkpointStage: ApplicationCheckpoint["stage"];
  checkpointUpdatedAt: string;
}
export type BetaEvidence = BetaConsent | BetaObservation;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const consentKey = (id: string) => `consent:${id}`;
const observationKey = (run: string, job: string) => `observation:${run}:${digest(job)}`;

export async function recordConsent(store: ApplicationStateStore<BetaEvidence>, raw: unknown): Promise<BetaConsent> {
  const input = betaConsentSchema.parse(raw);
  const key = consentKey(input.participantId);
  const prior = await store.read(key);
  if (prior && prior.state.kind !== "consent") throw new Error("Beta consent record identity is occupied");
  if (prior?.state.kind === "consent") {
    const { withdrawnAt: previousWithdrawal, ...previous } = prior.state;
    const { withdrawnAt: nextWithdrawal, ...next } = input;
    if (previousWithdrawal || !nextWithdrawal || nextWithdrawal <= input.recordedAt
      || !isDeepStrictEqual(previous, next)) {
      throw new Error("Consent is immutable except for a later withdrawal");
    }
  }
  if (!await store.compareAndSwap(key, prior?.version, input)) throw new Error("Beta consent changed concurrently");
  return input;
}

export async function recordObservation(store: ApplicationStateStore<BetaEvidence>, raw: unknown,
  checkpoint: ApplicationCheckpoint): Promise<BetaObservation> {
  const input = betaObservationSchema.parse(raw);
  const saved = (await store.read(consentKey(input.participantId)))?.state;
  if (!saved || saved.kind !== "consent" || saved.withdrawnAt || !saved.approvedProviders.includes(input.provider)
    || input.recordedAt < saved.recordedAt) throw new Error("Active beta consent does not cover this provider");
  if (input.jobId !== checkpoint.jobId || !checkpoint.officialUrl) {
    throw new Error("Beta observation does not match the exact application checkpoint");
  }
  if (input.recordedAt < checkpoint.updatedAt) {
    throw new Error("Beta observation predates the saved application checkpoint");
  }
  if (input.outcome === "submitted" && (checkpoint.stage !== "submitted"
    || !checkpoint.confirmation?.trim())) {
    throw new Error("Submitted beta evidence requires a confirmed job-bound checkpoint and consent");
  }
  if (input.outcome !== "submitted" && input.outcome !== checkpoint.stage) {
    throw new Error("Beta outcome must match the saved application checkpoint");
  }
  const record: BetaObservation = { ...input, officialUrlSha256: digest(checkpoint.officialUrl),
    confirmationPresent: checkpoint.stage === "submitted" && Boolean(checkpoint.confirmation?.trim()),
    checkpointStage: checkpoint.stage, checkpointUpdatedAt: checkpoint.updatedAt };
  const key = observationKey(input.runId, input.jobId);
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
