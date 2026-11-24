import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { verifyResumePdf } from "../src/resume/verify-pdf.js";
import type { ResumeSource } from "../src/resume/jake.js";
import type { DiscoveredJob } from "../src/types.js";

const job: DiscoveredJob = {
  id: "test:123", provider: "greenhouse", company: "Example Co", title: "Backend Engineer",
  location: null, department: null, employmentType: null, workplaceType: null, compensation: null,
  descriptionText: "Python services", applicationUrl: "https://example.com/apply",
  sourceUrl: "https://example.com/job", sourcePublishedAt: null, sourceUpdatedAt: null,
  firstSeenAt: "2026-11-24T00:00:00Z", discoveredAt: "2026-11-24T00:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [],
};
const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], projects: [],
  experience: [{ employer: "Weboni", title: "Engineer", employmentType: "Full-time", start: "2024", end: "Present",
    claims: [{ id: "claim-1", claim: "Built Python services", skills: ["Python"],
      evidence: [{ source: "work history", uri: "private:work" }], status: "verified", allowedUses: ["resume"] }] }],
});
const renderToken = createHash("sha256").update(`${job.id}\0fixture`).digest("hex");
const latex = `\\hypersetup{pdfsubject={OpenApply:${renderToken}}}\nfixture`;
const source: ResumeSource = { latex, renderToken, fingerprint: createHash("sha256")
  .update(`${job.id}\0${latex}`).digest("hex"), claimIds: ["claim-1"] };

async function fixture(path: string, options: { title?: string; claim?: string; offPage?: boolean;
  overlap?: boolean; link?: boolean; subject?: string;
  extraLink?: string } = {}): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.setSubject(options.subject ?? `OpenApply:${renderToken}`);
  const page = pdf.addPage([612, 792]);
  page.drawText("Test Candidate", { x: 40, y: 740 });
  page.drawText(options.title ?? "Backend Engineer", { x: 40, y: 720 });
  page.drawText("Example Co", { x: 40, y: 700 });
  page.drawText(options.claim ?? "Built Python services", { x: options.offPage ? 800 : 40, y: 680 });
  if (options.overlap) page.drawText("Overlapping sentence", { x: 40, y: 680 });
  if (options.link !== false) {
    const annotation = pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 730, 150, 745],
      Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of("mailto:test@example.com") } });
    page.node.addAnnot(pdf.context.register(annotation));
  }
  if (options.extraLink) {
    const annotation = pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 710, 150, 725],
      Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(options.extraLink) } });
    page.node.addAnnot(pdf.context.register(annotation));
  }
  await writeFile(path, await pdf.save());
}

describe("job-bound PDF verification", () => {
  it("accepts a readable role-specific PDF and fingerprints its exact bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-pdf-"));
    try {
      const path = join(root, "resume.pdf");
      await fixture(path);
      const result = await verifyResumePdf(path, job, candidate, source);
      expect(result.jobId).toBe(job.id);
      expect(result.sourceFingerprint).toBe(source.fingerprint);
      expect(result.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.pages).toBe(1);
      await expect(verifyResumePdf(path, job, candidate, { ...source, fingerprint: "f".repeat(64) }))
        .rejects.toThrow("fingerprint");
      await expect(verifyResumePdf(path, job, candidate, { ...source, renderToken: "b".repeat(64) }))
        .rejects.toThrow("fingerprint");
      await fixture(path, { subject: "Another résumé" });
      await expect(verifyResumePdf(path, job, candidate, source)).rejects.toThrow("source token");
      await fixture(path, { title: "Other Role" });
      await expect(verifyResumePdf(path, job, candidate, source)).rejects.toThrow("role title");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects off-page or overlapping text, missing links, and non-PDF uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-pdf-"));
    try {
      const path = join(root, "resume.pdf");
      await fixture(path, { offPage: true });
      await expect(verifyResumePdf(path, job, candidate, source)).rejects.toThrow();
      await fixture(path, { overlap: true });
      await expect(verifyResumePdf(path, job, candidate, source)).rejects.toThrow("overlapping text");
      await fixture(path, { link: false });
      await expect(verifyResumePdf(path, job, candidate, source)).rejects.toThrow("email link");
      await fixture(path, { extraLink: "https://unapproved.example/" });
      await expect(verifyResumePdf(path, job, candidate, source)).rejects.toThrow("unapproved link");
      await writeFile(path, "Not a PDF".repeat(20));
      await expect(verifyResumePdf(path, job, candidate, source)).rejects.toThrow("not a PDF");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves material punctuation when matching approved claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-pdf-"));
    try {
      const path = join(root, "resume.pdf");
      await fixture(path, { claim: "Built Python services 50" });
      const withPercent = candidateProfileSchema.parse({ ...candidate,
        experience: candidate.experience.map((role) => ({ ...role,
          claims: role.claims.map((claim) => ({ ...claim, claim: "Built Python services 50%" })) })) });
      await expect(verifyResumePdf(path, job, withPercent, source)).rejects.toThrow("approved claim claim-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
