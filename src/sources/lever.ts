import { z } from "zod";
import { asString, htmlToText, isoOrNull } from "../lib/text.js";
import type { NormalizedJob } from "../types.js";

const postingSchema = z.array(z.looseObject({
  id: z.union([z.string(), z.number()]),
  text: z.string(),
  hostedUrl: z.string().url(),
  applyUrl: z.string().url().optional(),
  createdAt: z.unknown().optional(),
  workplaceType: z.unknown().optional(),
  descriptionPlain: z.string().optional(),
  additionalPlain: z.string().optional(),
  description: z.string().optional(),
  additional: z.string().optional(),
  categories: z.looseObject({
    commitment: z.unknown().optional(),
    location: z.unknown().optional(),
    team: z.unknown().optional(),
  }).optional(),
  lists: z.array(z.looseObject({ text: z.unknown().optional(), content: z.unknown().optional() })).optional(),
}));

function epochIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return isoOrNull(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseLeverJobs(
  payload: unknown,
  context: { site: string; company: string },
): NormalizedJob[] {
  return postingSchema.parse(payload).map((posting) => {
    const id = String(posting.id);
    const listText = (posting.lists ?? [])
      .map((section) => `${asString(section.text) ?? ""}\n${htmlToText(asString(section.content) ?? "")}`)
      .join("\n");
    const description = [
      posting.descriptionPlain ?? htmlToText(posting.description ?? ""),
      listText,
      posting.additionalPlain ?? htmlToText(posting.additional ?? ""),
    ].filter(Boolean).join("\n").trim();

    return {
      id: `lever:${context.site}:${id}`,
      provider: "lever",
      company: context.company,
      title: posting.text.trim(),
      location: asString(posting.categories?.location),
      department: asString(posting.categories?.team),
      employmentType: asString(posting.categories?.commitment),
      workplaceType: asString(posting.workplaceType),
      compensation: null,
      descriptionText: description,
      applicationUrl: posting.applyUrl ?? `${posting.hostedUrl}/apply`,
      sourceUrl: posting.hostedUrl,
      sourcePublishedAt: epochIso(posting.createdAt),
      sourceUpdatedAt: null,
    };
  });
}
