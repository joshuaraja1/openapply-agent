import { z } from "zod";

export const evidenceSchema = z.object({
  source: z.string().min(1),
  uri: z.string().min(1),
  note: z.string().optional(),
});

export const claimSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  skills: z.array(z.string()).default([]),
  metrics: z.array(z.object({
    label: z.string().min(1),
    value: z.union([z.string(), z.number()]),
    unit: z.string().optional(),
  })).default([]),
  evidence: z.array(evidenceSchema).min(1),
  status: z.enum(["verified", "user-confirmed", "needs-confirmation", "do-not-use"]),
  allowedUses: z.array(z.enum(["matching", "resume", "application", "interview"])).default([]),
});

export const candidateProfileSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    fullName: z.string().min(1),
    location: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(1),
    portfolio: z.string().url().optional(),
    github: z.string().url().optional(),
    linkedin: z.string().url().optional(),
  }),
  authorization: z.object({
    countries: z.array(z.string()).min(1),
    sponsorshipRequiredNowOrFuture: z.boolean(),
  }),
  skills: z.record(z.string(), z.array(z.string())),
  education: z.array(claimSchema),
  experience: z.array(z.object({
    employer: z.string().min(1),
    title: z.string().min(1),
    employmentType: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    claims: z.array(claimSchema),
  })),
  projects: z.array(z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    claims: z.array(claimSchema),
  })),
  quarantinedClaims: z.array(claimSchema).default([]),
});

export const searchPreferencesSchema = z.object({
  version: z.literal(1),
  targetRoles: z.array(z.string()).min(1),
  excludeSeniorityTerms: z.array(z.string()).default(["senior", "staff", "principal", "lead", "manager", "director"]),
  workArrangements: z.object({
    preferred: z.array(z.string()),
    accepted: z.array(z.string()),
  }),
  compensation: z.object({
    preferredBaseFloor: z.number().nonnegative(),
    targetRangePosition: z.number().min(0).max(1).default(0.7),
  }),
  applicationPolicy: z.object({
    dailyTarget: z.number().int().positive().default(10),
    dailyHardCap: z.number().int().positive().default(25),
    requireFinalApproval: z.boolean().default(true),
  }),
});

export type CandidateProfile = z.infer<typeof candidateProfileSchema>;
export type SearchPreferences = z.infer<typeof searchPreferencesSchema>;
