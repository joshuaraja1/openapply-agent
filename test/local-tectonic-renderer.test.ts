import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { readBundledJakeTemplate } from "../src/resume/bundled-template.js";
import { createJakeResumeSource } from "../src/resume/jake.js";
import { renderLocalJakePdf } from "../src/resume/local-tectonic.js";
import type { DiscoveredJob } from "../src/types.js";

const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX",
    email: "test@example.invalid", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { general: ["Python"] }, education: [], projects: [],
  experience: [{ employer: "Example Lab", title: "Engineer", employmentType: "Full-time",
    start: "2024", end: "Present", claims: [{ id: "claim-1", claim: "Built Python services",
      skills: ["Python"], metrics: [], evidence: [{ source: "candidate-reviewed-intake",
        uri: "urn:openapply:onboarding:test#experience-1" }], status: "user-confirmed",
      allowedUses: ["matching", "resume", "application"] }] }], quarantinedClaims: [] });
const job: DiscoveredJob = { id: "greenhouse:acme:123456", provider: "greenhouse",
  company: "Acme", title: "Backend Engineer", descriptionText: "Python services",
  applicationUrl: "https://boards.greenhouse.io/acme/jobs/123456",
  sourceUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
  sourcePublishedAt: null, sourceUpdatedAt: null, location: null, department: null,
  employmentType: null, workplaceType: null, compensation: null,
  firstSeenAt: "2026-11-27T12:00:00Z", discoveredAt: "2026-11-27T12:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [] };

async function withSource(action: (root: string,
  source: ReturnType<typeof createJakeResumeSource>) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openapply-tex-")));
  try {
    await mkdir(join(root, "cache"), { mode: 0o700 });
    const source = createJakeResumeSource(await readBundledJakeTemplate(), job, candidate);
    await action(root, source);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("bounded local Jake renderer", () => {
  it("rejects a source that differs from the approved profile before invoking TeX", async () => {
    await withSource(async (root, source) => {
      let invoked = false;
      await expect(renderLocalJakePdf({ ...source, latex: source.latex + "\\input{/etc/passwd}" },
        job, candidate, root, { binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute() { invoked = true; return { stdout: "", stderr: "" }; } }))
        .rejects.toThrow("differs from approved Jake output");
      expect(invoked).toBe(false);
    });
  });

  it("cleans staging files on compiler failure without exposing diagnostics", async () => {
    await withSource(async (root, source) => {
      await expect(renderLocalJakePdf(source, job, candidate, root,
        { binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute() { throw new Error("private résumé content"); } }))
        .rejects.toThrow("compiler failed or timed out");
      expect(await readdir(root)).toEqual(["cache"]);
    });
  });

  it("passes a bounded timeout and cleans up when the compiler times out", async () => {
    await withSource(async (root, source) => {
      let timeout = 0;
      await expect(renderLocalJakePdf(source, job, candidate, root,
        { binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute(_binary, _args, options) {
            timeout = options.timeout ?? 0;
            throw Object.assign(new Error("private timeout output"), { killed: true });
          } })).rejects.toThrow("compiler failed or timed out");
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(20_000);
      expect(await readdir(root)).toEqual(["cache"]);
    });
  });

  it("rejects a symlinked compiler output and cleans the private stage", async () => {
    await withSource(async (root, source) => {
      await expect(renderLocalJakePdf(source, job, candidate, root,
        { binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute(_binary, _args, options) {
            await symlink(join(options.cwd as string, "main.tex"),
              join(options.cwd as string, "main.pdf"));
            return { stdout: "", stderr: "" };
          } })).rejects.toThrow("invalid PDF file");
      expect(await readdir(root)).toEqual(["cache"]);
    });
  });

  it("rejects oversized source before invoking a compiler", async () => {
    await withSource(async (root, source) => {
      let invoked = false;
      await expect(renderLocalJakePdf({ ...source, latex: source.latex + "x".repeat(200_001) },
        job, candidate, root, { binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute() { invoked = true; return { stdout: "", stderr: "" }; } }))
        .rejects.toThrow("inputs are invalid");
      expect(invoked).toBe(false);
    });
  });

  it("rejects a private work path reached through a symlinked parent", async () => {
    await withSource(async (root, source) => {
      await mkdir(join(root, "real-work"), { mode: 0o700 });
      await symlink(root, join(root, "alias"));
      let invoked = false;
      await expect(renderLocalJakePdf(source, job, candidate,
        join(root, "alias", "real-work"), {
          binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute() { invoked = true; return { stdout: "", stderr: "" }; },
        })).rejects.toThrow("not private");
      expect(invoked).toBe(false);
    });
  });

  it("refuses an oversized PDF and removes staging files", async () => {
    await withSource(async (root, source) => {
      await expect(renderLocalJakePdf(source, job, candidate, root,
        { binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute(_binary, _args, options) {
          await writeFile(join(options.cwd as string, "main.pdf"), Buffer.alloc(5_000_001));
          return { stdout: "", stderr: "" };
        } })).rejects.toThrow("invalid PDF file");
      expect(await readdir(root)).toEqual(["cache"]);
    });
  });

  it("refuses a wrong-job PDF after compilation and removes it", async () => {
    await withSource(async (root, source) => {
      await expect(renderLocalJakePdf(source, job, candidate, root,
        { binary: process.execPath, cacheDirectory: join(root, "cache"),
          async execute(_binary, _args, options) {
          const pdf = await PDFDocument.create();
          pdf.setSubject("OpenApply:wrong-job");
          const page = pdf.addPage([612, 792]);
          page.drawText("Test Candidate", { x: 40, y: 740,
            font: await pdf.embedFont(StandardFonts.Helvetica), size: 16 });
          await writeFile(join(options.cwd as string, "main.pdf"), await pdf.save());
          return { stdout: "", stderr: "" };
        } })).rejects.toThrow("expected source token");
      expect(await readdir(root)).toEqual(["cache"]);
    });
  });
});

describe.runIf(Boolean(process.env.OPENAPPLY_TECTONIC_BIN && process.env.OPENAPPLY_TECTONIC_CACHE))
  ("real offline Tectonic renderer", () => {
  it("renders the exact Jake PDF and passes claim and layout verification", async () => {
    await withSource(async (root, source) => {
      const artifact = await renderLocalJakePdf(source, job, candidate, root,
        { binary: process.env.OPENAPPLY_TECTONIC_BIN!,
          cacheDirectory: process.env.OPENAPPLY_TECTONIC_CACHE! });
      expect(artifact.jobId).toBe(job.id);
      expect(artifact.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
