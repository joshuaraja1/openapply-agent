import { createHash } from "node:crypto";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";

type Claim = CandidateProfile["education"][number];

export interface ResumeSource {
  latex: string;
  fingerprint: string;
  renderToken: string;
  claimIds: string[];
}

export function escapeLatex(value: string): string {
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&",
    "#": "\\#", "%": "\\%", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  };
  return value.replace(/[\\{}$&#%_~^]/g, (character) => replacements[character]!);
}

function safeUrl(value: string): string {
  const url = new URL(value);
  if (!(["http:", "https:"].includes(url.protocol))) throw new Error("Résumé link must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Résumé link must not contain credentials");
  return escapeHref(url.href);
}

function escapeHref(value: string): string {
  const encoded = value.replace(/[{}\\~^]/g, (character) => encodeURIComponent(character));
  return encoded.replace(/[%#&_$]/g, (character) => `\\${character}`);
}

function hasSkill(description: string, skill: string): boolean {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(description);
}

function approved(claim: Claim): boolean {
  return (claim.status === "verified" || claim.status === "user-confirmed")
    && claim.allowedUses.includes("resume");
}

function relevance(claim: Claim, description: string): number {
  return claim.skills.filter((skill) => hasSkill(description, skill)).length;
}

function selected(claims: Claim[], description: string, limit: number): Claim[] {
  return claims.filter(approved).map((claim, index) => ({ claim, index, score: relevance(claim, description) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(({ claim }) => claim);
}

function itemList(claims: Claim[]): string {
  return ["\\resumeItemListStart", ...claims.map((claim) => `  \\resumeItem{${escapeLatex(claim.claim)}}`),
    "\\resumeItemListEnd"].join("\n");
}

function contactLink(url: string | undefined, label: string): string | undefined {
  return url && `\\href{${safeUrl(url)}}{\\underline{${escapeLatex(label)}}}`;
}

/** Replaces only the content region of the MIT-licensed Jake template. */
export function createJakeResumeSource(template: string, job: DiscoveredJob, candidate: CandidateProfile): ResumeSource {
  const begin = template.indexOf("%----------HEADING----------");
  const end = template.lastIndexOf("%-------------------------------------------");
  if (begin < 0 || end <= begin || !template.slice(end).includes("\\end{document}")) {
    throw new Error("Jake résumé template markers are missing");
  }
  const experience = candidate.experience.map((role) => ({
    role, claims: selected(role.claims, job.descriptionText, 4),
  })).filter(({ claims }) => claims.length);
  const projects = candidate.projects.map((project) => ({
    project, claims: selected(project.claims, job.descriptionText, 3),
  })).filter(({ claims }) => claims.length);
  const education = candidate.education.filter(approved);
  const used = [...experience.flatMap(({ claims }) => claims), ...projects.flatMap(({ claims }) => claims)];
  if (!used.length) throw new Error("No approved, role-relevant résumé claims are available");
  const claimIds = [...education, ...used].map((claim) => claim.id);
  if (new Set(claimIds).size !== claimIds.length) throw new Error("Résumé claim IDs must be unique");
  const skills = [...new Set(used.flatMap((claim) => claim.skills))]
    .filter((skill) => hasSkill(job.descriptionText, skill)).slice(0, 12);
  const summaryClaims = used.slice(0, 2).map((claim) => claim.claim.trim().replace(/[.!?]+$/, ""));
  const summary = [
    `Candidate for the ${job.title} role at ${job.company}.`,
    `Relevant experience includes ${summaryClaims[0]}.`,
    ...(summaryClaims[1] ? [`Additional work includes ${summaryClaims[1]}.`] : []),
    `Relevant technical skills include ${skills.join(", ")}.`,
  ].map(escapeLatex).join(" ");
  const identity = candidate.identity;
  const contacts = [escapeLatex(identity.phone), escapeLatex(identity.location),
    `\\href{${escapeHref(`mailto:${identity.email}`)}}{\\underline{${escapeLatex(identity.email)}}}`,
    contactLink(identity.linkedin, "LinkedIn"), contactLink(identity.github, "GitHub"),
    contactLink(identity.portfolio, "Portfolio")].filter(Boolean).join(" $|$ ");
  const sections = [
    "%----------HEADING----------",
    "\\begin{center}",
    `  \\textbf{\\Huge \\scshape ${escapeLatex(identity.fullName)}} \\\\ \\vspace{1pt}`,
    `  \\small ${contacts}`,
    "\\end{center}",
    "\\section{Professional Summary}",
    `\\small{${summary}}`,
  ];
  if (education.length) sections.push("\\section{Education}", itemList(education));
  if (experience.length) {
    sections.push("\\section{Experience}", "\\resumeSubHeadingListStart");
    for (const { role, claims } of experience) {
      sections.push(`\\resumeSubheading{${escapeLatex(role.title)}}{${escapeLatex(`${role.start}--${role.end}`)}}`
        + `{${escapeLatex(role.employer)}}{${escapeLatex(role.employmentType)}}`, itemList(claims));
    }
    sections.push("\\resumeSubHeadingListEnd");
  }
  if (projects.length) {
    sections.push("\\section{Projects}", "\\resumeSubHeadingListStart");
    for (const { project, claims } of projects) {
      const title = project.url ? `\\href{${safeUrl(project.url)}}{${escapeLatex(project.name)}}`
        : escapeLatex(project.name);
      sections.push(`\\resumeProjectHeading{\\textbf{${title}}}{}`, itemList(claims));
    }
    sections.push("\\resumeSubHeadingListEnd");
  }
  sections.push("\\section{Technical Skills}", `\\small{${escapeLatex(skills.join(", "))}}`);
  const content = template.slice(0, begin) + sections.join("\n") + "\n\n" + template.slice(end);
  const renderToken = createHash("sha256").update(`${job.id}\0${content}`).digest("hex");
  const marker = `\\hypersetup{pdfsubject={OpenApply:${renderToken}}}\n`;
  const latex = content.slice(0, begin) + marker + content.slice(begin);
  return { latex, fingerprint: createHash("sha256").update(`${job.id}\0${latex}`).digest("hex"),
    renderToken, claimIds };
}
