import { z } from "zod";
import type { OfficialJobIdentity } from "./durable-journal.js";

const stageSchema = z.enum(["after_intent", "after_click", "after_confirmation"]);
export type SyntheticCrashStage = z.infer<typeof stageSchema>;
const fixtureJob = z.strictObject({ provider: z.literal("synthetic"),
  employerId: z.literal("fixture"), requisitionId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) });

export function syntheticCrashStage(env: NodeJS.ProcessEnv = process.env): SyntheticCrashStage | undefined {
  const value = env.OPENAPPLY_SYNTHETIC_CRASH_AT;
  if (value === undefined || value === "") return undefined;
  if (env.OPENAPPLY_CLOUD_TASK_MODE !== "synthetic"
    || env.OPENAPPLY_CLOUD_SYNTHETIC_ONLY !== "1"
    || env.OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK !== "1"
    || env.OPENAPPLY_SUBMISSION_MODE !== "disabled") {
    throw new Error("Synthetic crash probe is unavailable outside the guarded task");
  }
  return stageSchema.parse(value);
}

/** Task termination intentionally skips JS cleanup to reproduce an ECS crash.
 * Every caller must pass the exact broker-verified fixture job. */
export function syntheticCheckpoint(stage: SyntheticCrashStage, job: OfficialJobIdentity,
  env: NodeJS.ProcessEnv = process.env, exit: (code: number) => never = process.exit): void {
  const configured = syntheticCrashStage(env);
  fixtureJob.parse(job);
  if (configured === stage) exit(86);
}
