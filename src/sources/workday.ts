import { z } from "zod";
import { asString } from "../lib/text.js";
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

function publishedAt(value: unknown, now: Date): string | null {
  const text = asString(value)?.toLowerCase();
  if (!text) return null;
  if (text.includes("today")) return now.toISOString();
  if (text.includes("yesterday")) return new Date(now.getTime() - 86_400_000).toISOString();
  const match = text.match(/posted\s+(\d+)\s+days?\s+ago/);
  return match ? new Date(now.getTime() - Number(match[1]) * 86_400_000).toISOString() : null;
}

export function parseWorkdayJobs(
  payload: unknown,
  context: { host: string; tenant: string; site: string; company: string },
  now = new Date(),
): NormalizedJob[] {
  return responseSchema.parse(payload).jobPostings.map((job) => {
    const id = job.externalPath.split("_").at(-1) ?? job.externalPath;
    const url = `https://${context.host}/en-US/${context.site}${job.externalPath}`;
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
      sourcePublishedAt: publishedAt(job.postedOn, now),
      sourceUpdatedAt: null,
    };
  });
}
