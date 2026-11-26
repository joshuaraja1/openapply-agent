import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { createJakeResumeSource } from "../src/resume/jake.js";
import { verifyResumePdf } from "../src/resume/verify-pdf.js";
import type { DiscoveredJob } from "../src/types.js";

const run = promisify(execFile);
const job: DiscoveredJob = {
  id: "synthetic:backend-1", provider: "greenhouse", company: "Example Engineering",
  title: "Software Engineer", location: "Remote", department: "Engineering",
  employmentType: "Full-time", workplaceType: "remote", compensation: null,
  descriptionText: "Build Python and TypeScript services with Docker and SQL.",
  applicationUrl: "https://example.com/jobs/backend-1", sourceUrl: "https://example.com/jobs/backend-1",
  sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: "2026-01-01T00:00:00Z",
  discoveredAt: "2026-01-01T00:00:00Z", isNew: true, isFresh: true,
  freshnessBasis: "first-seen", matchedKeywords: ["Python", "TypeScript"],
};
const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Sample Candidate", location: "Dallas, TX", email: "sample@example.com",
    phone: "555-0100", portfolio: "https://example.com/portfolio" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: { languages: ["Python", "TypeScript", "SQL"] }, education: [], projects: [],
  experience: [{ employer: "Example Engineering", title: "Software Developer",
    employmentType: "Full-time", start: "2024", end: "2026", claims: [
      { id: "synthetic-python", claim: "Built Python services for an internal reporting workflow.",
        skills: ["Python", "SQL"], evidence: [{ source: "synthetic fixture", uri: "fixture:python" }],
        status: "verified", allowedUses: ["resume"] },
      { id: "synthetic-typescript", claim: "Improved TypeScript tooling for the engineering team.",
        skills: ["TypeScript", "Docker"], evidence: [{ source: "synthetic fixture", uri: "fixture:typescript" }],
        status: "verified", allowedUses: ["resume"] },
    ] }],
});

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!);
}

const count = Number(process.argv[2] ?? "5");
if (!Number.isInteger(count) || count < 1 || count > 20) {
  throw new Error("Pass a sample count from 1 through 20");
}
const template = await readFile(new URL("../templates/resume/main.tex", import.meta.url), "utf8");
const source = createJakeResumeSource(template, job, candidate);
const root = await mkdtemp(join(tmpdir(), "openapply-local-pdf-bench-"));
const compileMs: number[] = [];
const verifyMs: number[] = [];
let pdfBytes = 0;
try {
  // The benchmark uses only synthetic facts and no Overleaf account or network.
  // Production use still needs a separately proven OS/container sandbox.
  for (let index = 0; index < count; index += 1) {
    const directory = join(root, String(index));
    await mkdir(directory, { mode: 0o700 });
    const latexPath = join(directory, "resume.tex");
    const pdfPath = join(directory, "resume.pdf");
    await writeFile(latexPath, source.latex, { mode: 0o600 });
    const compileStart = performance.now();
    await run("tectonic", ["--only-cached", "--untrusted", "--outdir", directory, latexPath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
    compileMs.push(performance.now() - compileStart);
    const verifyStart = performance.now();
    await verifyResumePdf(pdfPath, job, candidate, source);
    verifyMs.push(performance.now() - verifyStart);
    pdfBytes = (await readFile(pdfPath)).length;
  }
  console.log(JSON.stringify({ samples: count, compiler: "tectonic --only-cached --untrusted",
    compileMs: { median: percentile(compileMs, 0.5), p95: percentile(compileMs, 0.95) },
    verifyMs: { median: percentile(verifyMs, 0.5), p95: percentile(verifyMs, 0.95) },
    pdfBytes, verified: count }, null, 2));
  if (process.env.OPENAPPLY_KEEP_SYNTHETIC_BENCH === "1") console.log(`Synthetic output: ${root}`);
} finally {
  if (process.env.OPENAPPLY_KEEP_SYNTHETIC_BENCH !== "1") {
    await rm(root, { recursive: true, force: true });
  }
}
