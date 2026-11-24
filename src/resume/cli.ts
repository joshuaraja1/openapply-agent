import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { applicationPackageSchema, jobSchema } from "../application/runner.js";
import { createApplicationHandoff } from "../application/handoff.js";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import { candidateProfileSchema } from "../candidate/schema.js";
import { sourceSchema } from "../config.js";
import type { DiscoveredJob } from "../types.js";
import { createJakeResumeSource } from "./jake.js";
import { assertLocalBrowserEndpoint, renderOverleafResume } from "./overleaf.js";

const renderInputSchema = z.object({
  version: z.literal(1), job: jobSchema, source: sourceSchema, candidate: candidateProfileSchema,
  browserEndpoint: z.url(), overleafProjectUrl: z.url(), outputDirectory: z.string().min(1),
  requireFinalApproval: z.boolean().default(true), expectedConfirmation: z.string().min(1).optional(),
});

const inputPath = process.env.OPENAPPLY_RENDER_INPUT;
if (!inputPath) throw new Error("Set OPENAPPLY_RENDER_INPUT to a private render input JSON file");
const input = renderInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
assertLocalBrowserEndpoint(input.browserEndpoint);
const job = input.job as DiscoveredJob;
const template = await readFile("templates/resume/main.tex", "utf8");
const resumeSource = createJakeResumeSource(template, job, input.candidate);
const connection = await connectBrowserOs(input.browserEndpoint);
const client: BrowserToolClient = { callTool: async (request) =>
  await connection.client.callTool(request) as BrowserToolResult };
try {
  const artifact = await renderOverleafResume(client, input.overleafProjectUrl, job,
    input.candidate, resumeSource, input.outputDirectory);
  const pkg = applicationPackageSchema.parse({ version: 1, job, source: input.source,
    candidate: input.candidate, handoff: createApplicationHandoff(job, input.requireFinalApproval),
    resumeSource, resumePdfPath: artifact.path,
    ...(input.expectedConfirmation ? { expectedConfirmation: input.expectedConfirmation } : {}),
  });
  const packagePath = join(input.outputDirectory, `application-${randomUUID()}.json`);
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ jobId: job.id, packagePath, pdfPath: artifact.path }));
} finally {
  await connection.close();
}
