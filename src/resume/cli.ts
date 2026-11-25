import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { applicationPackageSchema } from "../application/runner.js";
import { createApplicationHandoff } from "../application/handoff.js";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import type { DiscoveredJob } from "../types.js";
import { createJakeResumeSource } from "./jake.js";
import { assertLocalBrowserEndpoint, renderOverleafResume } from "./overleaf.js";
import { renderOwnedOverleafResume } from "./owned-overleaf.js";
import { renderInputSchema } from "./render-input.js";
import { createPrivateOutput } from "../storage/private-output.js";
import { readPrivateFile } from "../storage/private-path.js";

const inputPath = process.env.OPENAPPLY_RENDER_INPUT;
if (!inputPath) throw new Error("Set OPENAPPLY_RENDER_INPUT to a private render input JSON file");
const input = renderInputSchema.parse(JSON.parse(await readPrivateFile(resolve(inputPath))));
const outputDirectory = resolve(input.outputDirectory);
if (input.browserEndpoint) assertLocalBrowserEndpoint(input.browserEndpoint);
const job = input.job as DiscoveredJob;
const template = await readFile("templates/resume/main.tex", "utf8");
const resumeSource = createJakeResumeSource(template, job, input.candidate);
const connection = input.browserEndpoint ? await connectBrowserOs(input.browserEndpoint) : undefined;
try {
  const artifact = input.browserRuntime === "owned"
    ? await renderOwnedOverleafResume(input.overleafProjectUrl, job, input.candidate, resumeSource,
      outputDirectory, { profileDirectory: join(userInfo().homedir, ".openapply-agent", "browser-profile") })
    : await (async () => {
      const client: BrowserToolClient = { callTool: async (request) =>
        await connection!.client.callTool(request) as BrowserToolResult };
      return renderOverleafResume(client, input.overleafProjectUrl, job,
        input.candidate, resumeSource, outputDirectory);
    })();
  const pkg = applicationPackageSchema.parse({ version: 1, job, source: input.source,
    candidate: input.candidate, handoff: createApplicationHandoff(job, input.requireFinalApproval),
    resumeSource, resumePdfPath: artifact.path, browserRuntime: input.browserRuntime,
    ...(input.browserEndpoint ? { browserEndpoint: input.browserEndpoint } : {}),
    ...(input.expectedConfirmation ? { expectedConfirmation: input.expectedConfirmation } : {}),
  });
  const packagePath = join(outputDirectory, `application-${randomUUID()}.json`);
  await createPrivateOutput(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(JSON.stringify({ jobId: job.id, packagePath, pdfPath: artifact.path }));
} finally {
  await connection?.close();
}
