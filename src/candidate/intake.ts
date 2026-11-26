import { z } from "zod";
import { claimSchema, type CandidateProfile } from "./schema.js";

export const careerStageSchema = z.enum(["student", "new-graduate", "workforce"]);
export type CareerStage = z.infer<typeof careerStageSchema>;

export interface IntakeQuestion {
  id: string;
  prompt: string;
  required: boolean;
}

const commonQuestions: readonly IntakeQuestion[] = [
  { id: "master-resume", prompt: "Upload your master résumé", required: true },
  { id: "target-roles", prompt: "Which roles do you want?", required: true },
  { id: "locations", prompt: "Where are you willing to work?", required: true },
  { id: "authorization", prompt: "Where are you authorized to work, and will you need sponsorship?", required: true },
];

const stageQuestions: Record<CareerStage, readonly IntakeQuestion[]> = {
  student: [
    { id: "school", prompt: "Which school and degree program are you attending?", required: true },
    { id: "expected-graduation", prompt: "When do you expect to graduate?", required: true },
    { id: "transcript", prompt: "Upload a transcript if a target role requires one", required: false },
  ],
  "new-graduate": [
    { id: "graduation", prompt: "When did you graduate?", required: true },
    { id: "transcript", prompt: "Upload a transcript if a target role requires one", required: false },
  ],
  workforce: [
    { id: "experience-summary", prompt: "Summarize your work experience and employment types", required: true },
  ],
};

export function intakeQuestions(stage: CareerStage): readonly IntakeQuestion[] {
  return [...commonQuestions, ...stageQuestions[careerStageSchema.parse(stage)]];
}

const reviewSchema = z.object({
  claimId: z.string().min(1),
  exactClaim: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  allowedUses: z.array(z.enum(["matching", "resume", "application", "interview"])).default([]),
});

/** An extracted claim remains unusable until the candidate approves its exact text and uses. */
export function reviewExtractedClaim(
  draft: z.input<typeof claimSchema>,
  review: z.input<typeof reviewSchema>,
): z.output<typeof claimSchema> {
  const claim = claimSchema.parse(draft);
  const decision = reviewSchema.parse(review);
  if (claim.status !== "needs-confirmation") throw new Error("Only pending extracted claims can be reviewed");
  if (decision.claimId !== claim.id || decision.exactClaim !== claim.claim) {
    throw new Error("Claim changed since the candidate reviewed it");
  }
  if (claim.evidence.some(({ source, uri }) => /\{\{|\}\}/.test(`${source}${uri}`))) {
    throw new Error("Claim evidence still contains placeholders");
  }
  if (decision.decision === "reject") {
    if (decision.allowedUses.length) throw new Error("A rejected claim cannot have allowed uses");
    return { ...claim, status: "do-not-use", allowedUses: [] };
  }
  if (!decision.allowedUses.length) throw new Error("Approved claims need at least one allowed use");
  return { ...claim, status: "user-confirmed", allowedUses: [...new Set(decision.allowedUses)] };
}

/** Portable, private views of the structured source of truth; callers own secure storage. */
export function exportCandidateMarkdown(candidate: CandidateProfile): {
  profile: string; history: string;
} {
  const identity = { version: candidate.version, identity: candidate.identity,
    authorization: candidate.authorization, education: candidate.education };
  const history = { version: candidate.version, skills: candidate.skills,
    experience: candidate.experience, projects: candidate.projects,
    quarantinedClaims: candidate.quarantinedClaims };
  const fenced = (title: string, tag: string, value: unknown) =>
    `# ${title}\n\nPrivate candidate data. Do not commit this file.\n\n\`\`\`${tag}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
  return { profile: fenced("Candidate profile", "openapply-identity-json", identity),
    history: fenced("Work history", "openapply-history-json", history) };
}
