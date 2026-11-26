import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import type { ResumeSource } from "./jake.js";
import { inspectPdfPageImage } from "./visual-qa.js";

const require = createRequire(import.meta.url);
// PDF.js requires a literal forward slash suffix even for native Windows paths.
const standardFontDataUrl = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";

export interface VerifiedResumeArtifact {
  jobId: string;
  sourceFingerprint: string;
  pdfSha256: string;
  path: string;
  pages: number;
  verifiedAt: string;
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

interface TextBox { x: number; y: number; width: number; height: number }
const maxTextItemsPerPage = 1_500;

export function assertNoTextOverlap(boxes: TextBox[]): void {
  if (boxes.length > maxTextItemsPerPage) {
    throw new Error("Résumé PDF has too many text items to verify safely");
  }
  for (let first = 0; first < boxes.length; first += 1) {
    const a = boxes[first]!;
    for (let second = first + 1; second < boxes.length; second += 1) {
      const b = boxes[second]!;
      const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (horizontal > 4 && vertical > Math.min(a.height, b.height) * 0.6) {
        throw new Error("Résumé PDF contains overlapping text");
      }
    }
  }
}

function approvedClaimTexts(candidate: CandidateProfile, ids: string[]): Array<{ label: string; text: string }> {
  const claims = [...candidate.education, ...candidate.experience.flatMap((role) => role.claims),
    ...candidate.projects.flatMap((project) => project.claims)];
  return ids.map((id) => {
    const matching = claims.filter((claim) => claim.id === id && claim.allowedUses.includes("resume")
      && (claim.status === "verified" || claim.status === "user-confirmed"));
    if (matching.length !== 1) throw new Error(`Résumé claim ${id} has no unique approved source`);
    return { label: `approved claim ${id}`, text: matching[0]!.claim };
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
  const marker = `\\hypersetup{pdfsubject={OpenApply:${source.renderToken}}}\n`;
  const content = source.latex.replace(marker, "");
  const expectedRenderToken = createHash("sha256").update(`${job.id}\0${content}`).digest("hex");
  if (source.fingerprint !== expectedSourceFingerprint || !source.claimIds.length
    || !/^[a-f0-9]{64}$/.test(source.renderToken) || source.renderToken !== expectedRenderToken
    || !source.latex.includes(marker) || source.latex.indexOf(marker) !== source.latex.lastIndexOf(marker)) {
    throw new Error("Résumé source fingerprint or claims do not match this job");
  }
  const task = getDocument({ data: new Uint8Array(bytes), stopAtErrors: true, standardFontDataUrl });
  try {
    const document = await task.promise;
    const metadata = await document.getMetadata();
    if ((metadata?.info as { Subject?: string } | undefined)?.Subject !== `OpenApply:${source.renderToken}`) {
      throw new Error("Résumé PDF was not rendered from the expected source token");
    }
    if (document.numPages < 1 || document.numPages > 2) throw new Error("Résumé PDF must have one or two pages");
    const pageTexts: string[] = [];
    let hasContactLink = false;
    const approvedLinks = new Set([`mailto:${candidate.identity.email.toLowerCase()}`,
      ...[candidate.identity.linkedin, candidate.identity.github, candidate.identity.portfolio]
        .filter((url): url is string => Boolean(url)).map((url) => new URL(url).href.toLowerCase())]);
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      if (Math.abs(viewport.width - 612) > 5 || Math.abs(viewport.height - 792) > 5) {
        throw new Error("Résumé PDF page is not US Letter size");
      }
      const content = await page.getTextContent();
      if (!content.items.length) throw new Error("Résumé PDF has no extractable text");
      if (content.items.length > maxTextItemsPerPage) {
        throw new Error("Résumé PDF has too many text items to verify safely");
      }
      const text = content.items.flatMap((item) => "str" in item ? [item.str] : []);
      pageTexts.push(text.join(" "));
      const boxes: TextBox[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const x = item.transform[4] ?? -1;
        const y = item.transform[5] ?? -1;
        const height = Math.abs(item.height);
        if (x < -2 || y < -2 || x + item.width > viewport.width + 2
          || y + height > viewport.height + 2) {
          throw new Error("Résumé PDF contains text outside the page bounds");
        }
        if (item.width > 0 && height > 0) boxes.push({ x, y, width: item.width, height });
      }
      assertNoTextOverlap(boxes);
      const image = await inspectPdfPageImage(page);
      // A short overflow onto page two can be legible yet still produce an unusable résumé.
      if (index === 2 && image.inkRows / image.height < 0.12) {
        throw new Error("Résumé PDF has a mostly empty second page");
      }
      const annotations = await page.getAnnotations();
      for (const annotation of annotations) {
        if (annotation.subtype !== "Link") continue;
        const destination = annotation.url?.toLowerCase();
        if (!destination || !approvedLinks.has(destination)) {
          throw new Error("Résumé PDF contains an unapproved link destination");
        }
        if (destination === `mailto:${candidate.identity.email.toLowerCase()}`) hasContactLink = true;
      }
    }
    const allText = normalize(pageTexts.join(" "));
    const required = [
      { label: "candidate name", text: candidate.identity.fullName },
      { label: "role title", text: job.title },
      { label: "company", text: job.company },
      ...approvedClaimTexts(candidate, source.claimIds),
    ];
    for (const phrase of required) {
      if (!allText.includes(normalize(phrase.text))) throw new Error(`Résumé PDF is missing ${phrase.label}`);
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
