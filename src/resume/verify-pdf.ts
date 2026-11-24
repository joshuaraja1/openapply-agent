import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import type { ResumeSource } from "./jake.js";

const require = createRequire(import.meta.url);
const standardFontDataUrl = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + sep;

export interface VerifiedResumeArtifact {
  jobId: string;
  sourceFingerprint: string;
  pdfSha256: string;
  path: string;
  pages: number;
  verifiedAt: string;
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function approvedClaimTexts(candidate: CandidateProfile, ids: string[]): string[] {
  const claims = [...candidate.education, ...candidate.experience.flatMap((role) => role.claims),
    ...candidate.projects.flatMap((project) => project.claims)];
  return ids.map((id) => {
    const matching = claims.filter((claim) => claim.id === id && claim.allowedUses.includes("resume")
      && (claim.status === "verified" || claim.status === "user-confirmed"));
    if (matching.length !== 1) throw new Error(`Résumé claim ${id} has no unique approved source`);
    return matching[0]!.claim;
  });
}

/** Validates the downloaded PDF against the job and the exact source used to render it. */
export async function verifyResumePdf(
  path: string, job: DiscoveredJob, candidate: CandidateProfile, source: ResumeSource,
): Promise<VerifiedResumeArtifact> {
  const absolute = resolve(path);
  const file = await lstat(absolute);
  if (!file.isFile() || file.isSymbolicLink() || file.size < 100 || file.size > 5_000_000) {
    throw new Error("Résumé PDF must be a regular file between 100 bytes and 5 MB");
  }
  const bytes = await readFile(absolute);
  if (bytes.length !== file.size) throw new Error("Résumé PDF changed while being verified");
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Résumé artifact is not a PDF");
  const expectedSourceFingerprint = createHash("sha256").update(`${job.id}\0${source.latex}`).digest("hex");
  if (source.fingerprint !== expectedSourceFingerprint || !source.claimIds.length) {
    throw new Error("Résumé source fingerprint or claims do not match this job");
  }
  const task = getDocument({ data: new Uint8Array(bytes), stopAtErrors: true, standardFontDataUrl });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > 2) throw new Error("Résumé PDF must have one or two pages");
    const pageTexts: string[] = [];
    let hasContactLink = false;
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      if (Math.abs(viewport.width - 612) > 5 || Math.abs(viewport.height - 792) > 5) {
        throw new Error("Résumé PDF page is not US Letter size");
      }
      const content = await page.getTextContent();
      if (!content.items.length) throw new Error("Résumé PDF has no extractable text");
      const text = content.items.flatMap((item) => "str" in item ? [item.str] : []);
      pageTexts.push(text.join(" "));
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const x = item.transform[4] ?? -1;
        const y = item.transform[5] ?? -1;
        if (x < -2 || y < -2 || x + item.width > viewport.width + 2 || y > viewport.height + 2) {
          throw new Error("Résumé PDF contains text outside the page bounds");
        }
      }
      const annotations = await page.getAnnotations();
      hasContactLink ||= annotations.some((annotation) => annotation.subtype === "Link"
        && annotation.url?.toLowerCase() === `mailto:${candidate.identity.email.toLowerCase()}`);
    }
    const allText = normalize(pageTexts.join(" "));
    const required = [candidate.identity.fullName, job.title, job.company,
      ...approvedClaimTexts(candidate, source.claimIds)];
    for (const phrase of required) {
      if (!allText.includes(normalize(phrase))) throw new Error(`Résumé PDF is missing expected text: ${phrase}`);
    }
    if (!hasContactLink) throw new Error("Résumé PDF has no active candidate email link");
    return {
      jobId: job.id, sourceFingerprint: source.fingerprint,
      pdfSha256: createHash("sha256").update(bytes).digest("hex"), path: absolute,
      pages: document.numPages, verifiedAt: new Date().toISOString(),
    };
  } finally {
    await task.destroy();
  }
}
