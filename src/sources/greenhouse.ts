import { z } from "zod";
import { asString, htmlToText, isoOrNull } from "../lib/text.js";
import type { NormalizedJob } from "../types.js";

const responseSchema = z.object({
  jobs: z.array(z.looseObject({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    absolute_url: z.string().url(),
    content: z.string().default(""),
    updated_at: z.unknown().optional(),
    location: z.looseObject({ name: z.unknown().optional() }).optional(),
    departments: z.array(z.looseObject({ name: z.unknown().optional() })).optional(),
    metadata: z.array(z.looseObject({ name: z.unknown(), value: z.unknown() })).nullable().optional(),
  })),
});

export function parseGreenhouseJobs(
  payload: unknown,
  context: { boardToken: string; company: string },
): NormalizedJob[] {
  return responseSchema.parse(payload).jobs.map((job) => {
    const id = String(job.id);
    const metadata = job.metadata ?? [];
    const valueFor = (name: string) => asString(
      metadata.find((entry) => asString(entry.name)?.toLowerCase() === name.toLowerCase())?.value,
    );
    return {
      id: `greenhouse:${context.boardToken}:${id}`,
      provider: "greenhouse",
      company: context.company,
      title: job.title.trim(),
      location: asString(job.location?.name),
      department: asString(job.departments?.[0]?.name),
      employmentType: valueFor("Employment Type"),
      workplaceType: valueFor("Workplace Type"),
      compensation: valueFor("Salary Range"),
      descriptionText: htmlToText(job.content),
      applicationUrl: job.absolute_url,
      sourceUrl: `https://boards-api.greenhouse.io/v1/boards/${context.boardToken}/jobs/${id}`,
      sourcePublishedAt: null,
      sourceUpdatedAt: isoOrNull(job.updated_at),
    };
  });
}
