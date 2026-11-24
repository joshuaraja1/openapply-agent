import { z } from "zod";
import { candidateProfileSchema, searchPreferencesSchema } from "./schema.js";

function fencedJson(markdown: string, tag: string): unknown {
  const blocks = [...markdown.replaceAll("\r\n", "\n").matchAll(/^```([^\n]+)\n([\s\S]*?)^```\s*$/gm)]
    .filter((match) => match[1]?.trim() === tag);
  if (blocks.length !== 1) throw new Error(`Expected exactly one ${tag} fenced JSON block`);
  const raw = blocks[0]![2]!;
  if (/\{\{[^}]*\}\}/.test(raw)) throw new Error(`Complete every ${tag} placeholder before compiling`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`The ${tag} block must contain valid JSON`);
  }
}

const identitySection = candidateProfileSchema.pick({ version: true, identity: true,
  authorization: true, education: true });
const historySection = candidateProfileSchema.pick({ version: true, skills: true,
  experience: true, projects: true, quarantinedClaims: true });

export function compileCandidateMarkdown(profileMarkdown: string, historyMarkdown: string) {
  const identity = identitySection.parse(fencedJson(profileMarkdown, "openapply-identity-json"));
  const history = historySection.parse(fencedJson(historyMarkdown, "openapply-history-json"));
  const candidate = candidateProfileSchema.parse({ ...identity, ...history });
  const approved = [...candidate.education, ...candidate.experience.flatMap((entry) => entry.claims),
    ...candidate.projects.flatMap((entry) => entry.claims)]
    .some((claim) => ["verified", "user-confirmed"].includes(claim.status)
      && claim.allowedUses.includes("resume"));
  if (!approved) throw new Error("At least one evidenced résumé claim must be approved");
  return candidate;
}

export function compileSearchMarkdown(markdown: string): z.infer<typeof searchPreferencesSchema> {
  return searchPreferencesSchema.parse(fencedJson(markdown, "openapply-search-json"));
}
