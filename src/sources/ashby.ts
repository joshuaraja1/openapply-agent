import { z } from "zod";
import { asString, htmlToText, isoOrNull } from "../lib/text.js";
import type { NormalizedJob } from "../types.js";

const responseSchema = z.object({
  jobs: z.array(z.looseObject({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    jobUrl: z.string().url(),
    applyUrl: z.string().url().optional(),
    location: z.unknown().optional(),
    department: z.unknown().optional(),
    team: z.unknown().optional(),
    employmentType: z.unknown().optional(),
    workplaceType: z.unknown().optional(),
    descriptionHtml: z.string().optional(),
    descriptionPlain: z.string().optional(),
    publishedAt: z.unknown().optional(),
    updatedAt: z.unknown().optional(),
    compensation: z.unknown().optional(),
  })),
});

function compensationText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return asString(record.compensationTierSummary)
    ?? asString(record.scrapeableCompensationSalarySummary);
}

export function parseAshbyJobs(
  payload: unknown,
  context: { boardName: string; company: string },
): NormalizedJob[] {
  return responseSchema.parse(payload).jobs.map((job) => {
    const id = String(job.id);
    const html = job.descriptionHtml ?? "";
    return {
      id: `ashby:${context.boardName}:${id}`,
      provider: "ashby",
      company: context.company,
      title: job.title.trim(),
      location: asString(job.location),
      department: asString(job.department) ?? asString(job.team),
      employmentType: asString(job.employmentType),
      workplaceType: asString(job.workplaceType),
      compensation: compensationText(job.compensation),
      descriptionText: job.descriptionPlain?.trim() || htmlToText(html),
      applicationUrl: job.applyUrl ?? job.jobUrl,
      sourceUrl: job.jobUrl,
      sourcePublishedAt: isoOrNull(job.publishedAt),
      sourceUpdatedAt: isoOrNull(job.updatedAt),
    };
  });
}
