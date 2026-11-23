import { z } from "zod";
import { asString, htmlToText, isoOrNull } from "../lib/text.js";
import type { NormalizedJob } from "../types.js";

const locationSchema = z.looseObject({
  fullLocation: z.unknown().optional(),
  city: z.unknown().optional(),
  region: z.unknown().optional(),
  country: z.unknown().optional(),
  remote: z.boolean().optional(),
  hybrid: z.boolean().optional(),
}).optional();

const postingSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  releasedDate: z.unknown().optional(),
  postingUrl: z.string().url().optional(),
  applyUrl: z.string().url().optional(),
  ref: z.string().url().optional(),
  location: locationSchema,
  department: z.looseObject({ label: z.unknown().optional() }).optional(),
  typeOfEmployment: z.looseObject({ label: z.unknown().optional() }).optional(),
  jobAd: z.looseObject({
    sections: z.record(z.string(), z.looseObject({ text: z.unknown().optional() })).optional(),
  }).optional(),
});

const listSchema = z.object({ content: z.array(postingSchema) });

function locationText(value: z.infer<typeof locationSchema>): string | null {
  if (!value) return null;
  return asString(value.fullLocation)
    ?? ([asString(value.city), asString(value.region), asString(value.country)]
      .filter(Boolean)
      .join(", ") || null);
}

function workplaceType(value: z.infer<typeof locationSchema>): string | null {
  if (value?.remote) return "Remote";
  if (value?.hybrid) return "Hybrid";
  return null;
}

function descriptionText(posting: z.infer<typeof postingSchema>): string {
  return Object.values(posting.jobAd?.sections ?? {})
    .map((section) => htmlToText(asString(section.text) ?? ""))
    .filter(Boolean)
    .join("\n");
}

function normalize(
  posting: z.infer<typeof postingSchema>,
  context: { companyIdentifier: string; company: string },
): NormalizedJob {
  const id = String(posting.id);
  const postingUrl = posting.postingUrl
    ?? `https://jobs.smartrecruiters.com/${context.companyIdentifier}/${id}`;
  return {
    id: `smartrecruiters:${context.companyIdentifier}:${id}`,
    provider: "smartrecruiters",
    company: context.company,
    title: posting.name.trim(),
    location: locationText(posting.location),
    department: asString(posting.department?.label),
    employmentType: asString(posting.typeOfEmployment?.label),
    workplaceType: workplaceType(posting.location),
    compensation: null,
    descriptionText: descriptionText(posting),
    applicationUrl: posting.applyUrl ?? postingUrl,
    sourceUrl: postingUrl,
    sourcePublishedAt: isoOrNull(posting.releasedDate),
    sourceUpdatedAt: null,
  };
}

export function parseSmartRecruitersJobs(
  payload: unknown,
  context: { companyIdentifier: string; company: string },
): NormalizedJob[] {
  const value = Array.isArray(payload) ? payload.map((item) => postingSchema.parse(item)) : listSchema.parse(payload).content;
  return value.map((posting) => normalize(posting, context));
}
