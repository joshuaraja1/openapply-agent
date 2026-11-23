import { z } from "zod";
import type { DiscoveredJob } from "../types.js";

export const stopConditionSchema = z.enum([
  "captcha",
  "mfa",
  "unknown-sensitive-question",
  "unsupported-claim",
  "ambiguous-compliance-disclosure",
  "low-confidence-field",
  "final-submit",
]);

export const applicationHandoffSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  applicationUrl: z.string().url(),
  mode: z.enum(["prepare", "submit-after-approval"]),
  allowedDomains: z.array(z.string()).min(1),
  requiredArtifacts: z.array(z.enum(["resume", "cover-letter"])),
  stopConditions: z.array(stopConditionSchema).min(1),
});

export type ApplicationHandoff = z.infer<typeof applicationHandoffSchema>;

export function createApplicationHandoff(
  job: DiscoveredJob,
  requireFinalApproval = true,
): ApplicationHandoff {
  return applicationHandoffSchema.parse({
    version: 1,
    jobId: job.id,
    applicationUrl: job.applicationUrl,
    mode: requireFinalApproval ? "prepare" : "submit-after-approval",
    allowedDomains: [new URL(job.applicationUrl).hostname],
    requiredArtifacts: ["resume"],
    stopConditions: [
      "captcha",
      "mfa",
      "unknown-sensitive-question",
      "unsupported-claim",
      "ambiguous-compliance-disclosure",
      "low-confidence-field",
      ...(requireFinalApproval ? ["final-submit" as const] : []),
    ],
  });
}
