import { z } from "zod";
import { asString, isoOrNull } from "../lib/text.js";
import type { NormalizedJob } from "../types.js";

const responseSchema = z.object({
  jobPostings: z.array(z.looseObject({
    title: z.string(),
    externalPath: z.string(),
    locationsText: z.unknown().optional(),
    postedOn: z.unknown().optional(),
    bulletFields: z.array(z.unknown()).optional(),
  })),
});

function lowerBoundDays(value: unknown): number | undefined {
  const text = asString(value)?.toLowerCase();
  if (!text) return undefined;
  if (text.includes("today")) return 0;
  if (text.includes("yesterday")) return 1;
  const match = text.match(/posted\s+(\d+)\+?\s+days?\s+ago/);
  return match ? Number(match[1]) : undefined;
}

export function parseWorkdayJobs(
  payload: unknown,
  context: { host: string; tenant: string; site: string; company: string },
  _now = new Date(),
): NormalizedJob[] {
  return responseSchema.parse(payload).jobPostings.map((job) => {
    const id = job.externalPath.split("_").at(-1) ?? job.externalPath;
    const url = `https://${context.host}/en-US/${context.site}${job.externalPath}`;
    const relativeAge = lowerBoundDays(job.postedOn);
    return {
      id: `workday:${context.tenant}:${context.site}:${id}`,
      provider: "workday",
      company: context.company,
      title: job.title.trim(),
      location: asString(job.locationsText),
      department: null,
      employmentType: null,
      workplaceType: null,
      compensation: null,
      descriptionText: (job.bulletFields ?? []).map(asString).filter(Boolean).join("\n"),
      applicationUrl: url,
      sourceUrl: url,
      sourcePublishedAt: isoOrNull(job.postedOn),
      sourceUpdatedAt: null,
      ...(relativeAge !== undefined ? { sourceAgeLowerBoundDays: relativeAge } : {}),
    };
  });
}
