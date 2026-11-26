import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../src/browser/client.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import { createJakeResumeSource } from "../src/resume/jake.js";
import { assertLocalBrowserEndpoint, assertOverleafProjectUrl, renderOverleafResume } from "../src/resume/overleaf.js";
import type { DiscoveredJob } from "../src/types.js";

const enabled = process.env.OPENAPPLY_LIVE_OVERLEAF_STAGE === "run-once";

it.runIf(enabled)("compiles and verifies a synthetic résumé in a disposable Overleaf project", async () => {
  const projectUrl = process.env.OPENAPPLY_OVERLEAF_STAGE_PROJECT_URL;
  const endpoint = process.env.OPENAPPLY_BROWSEROS_ENDPOINT;
  if (!projectUrl || !endpoint) {
    throw new Error("Set the disposable Overleaf project URL and local BrowserOS endpoint");
  }
  assertOverleafProjectUrl(projectUrl);
  assertLocalBrowserEndpoint(endpoint);
  const suffix = randomUUID().slice(0, 8);
  const job = {
    id: `stage:overleaf:${suffix}`, company: "Example Systems", title: "Synthetic Software Engineer",
    descriptionText: "Build Python and SQL services.", applicationUrl: "https://example.invalid/apply",
  } as DiscoveredJob;
  const claim = (id: string, text: string, skill: string) => ({
    id, claim: text, skills: [skill], evidence: [{ source: "synthetic fixture", uri: "private:fixture" }],
    status: "verified" as const, allowedUses: ["resume" as const],
  });
  const candidate = candidateProfileSchema.parse({
    version: 1,
    identity: { fullName: `Fixture ${suffix}`, location: "Dallas, TX",
      email: `fixture-${suffix}@example.com`, phone: "555-0100" },
    authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
    skills: { languages: ["Python", "SQL"] },
    education: [],
    experience: [{ employer: "Example Systems", title: "Software Engineer", employmentType: "Full-time",
      start: "2024", end: "Present", claims: [claim("python", "Built sample Python services", "Python")] }],
    projects: [{ name: "Sample Data Project", claims: [claim("sql", "Processed sample records with SQL", "SQL")] }],
  });
  const source = createJakeResumeSource(await readFile("templates/resume/main.tex", "utf8"), job, candidate);
  const outputDirectory = await mkdtemp(join(tmpdir(), "openapply-live-overleaf-"));
  let connection: Awaited<ReturnType<typeof connectBrowserOs>> | undefined;
  try {
    connection = await connectBrowserOs(endpoint);
    const client: BrowserToolClient = { callTool: async (request) =>
      await connection!.client.callTool(request) as BrowserToolResult };
    const artifact = await renderOverleafResume(client, projectUrl, job, candidate, source, outputDirectory);
    expect(artifact).toMatchObject({ jobId: job.id, sourceFingerprint: source.fingerprint, pages: 1 });
    expect(artifact.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await connection?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}, 90_000);
