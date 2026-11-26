import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { queueRunnerConfigSchema } from "../application/queue-config.js";
import { searchPreferencesSchema } from "../candidate/schema.js";
import { discoveryInputSchema, sourceSchema } from "../config.js";
import { assertLocalBrowserEndpoint, assertOverleafProjectUrl } from "../resume/overleaf.js";
import { createPrivateOutput } from "../storage/private-output.js";
import { readPrivateFile } from "../storage/private-path.js";

export const firstSourceSchema = z.strictObject({
  provider: z.enum(["greenhouse", "ashby", "lever", "smartrecruiters", "jsonld"]),
  company: z.string().trim().min(1).max(100),
  identifier: z.string().trim().min(1).max(500),
});
export const runtimeSetupInputSchema = z.strictObject({
  browserRuntime: z.enum(["owned", "browseros"]),
  browserEndpoint: z.url().optional(),
  overleafProjectUrl: z.url(),
  dailyTarget: z.number().int().min(1).max(100),
  dailyHardCap: z.number().int().min(1).max(100),
  requireFinalApproval: z.boolean(),
  firstSource: firstSourceSchema,
});
export type RuntimeSetupInput = z.infer<typeof runtimeSetupInputSchema>;

function officialSource(input: RuntimeSetupInput["firstSource"]) {
  const base = { company: input.company, enabled: true };
  if (input.provider === "jsonld") {
    const url = new URL(input.identifier);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      throw new Error("Employer career page must use credential-free HTTPS");
    }
    return sourceSchema.parse({ ...base, provider: "jsonld", url: url.href });
  }
  if (!/^[a-z0-9_-]{1,100}$/i.test(input.identifier)) {
    throw new Error("ATS board identifier must be a short slug");
  }
  const allowedApplicationHosts = input.provider === "greenhouse"
    ? ["boards.greenhouse.io", "job-boards.greenhouse.io"]
    : input.provider === "ashby" ? ["jobs.ashbyhq.com"]
      : input.provider === "lever" ? ["jobs.lever.co"] : ["jobs.smartrecruiters.com"];
  const property = input.provider === "greenhouse" ? "boardToken"
    : input.provider === "ashby" ? "boardName"
      : input.provider === "lever" ? "site" : "companyIdentifier";
  return sourceSchema.parse({ ...base, provider: input.provider,
    [property]: input.identifier, allowedApplicationHosts });
}

/** Create first-run files only; never overwrite an existing private policy. */
export async function createFirstRuntimeConfig(destination: string, queueConfigPath: string,
  raw: unknown): Promise<void> {
  const input = runtimeSetupInputSchema.parse(raw);
  assertOverleafProjectUrl(input.overleafProjectUrl);
  if (input.browserRuntime === "browseros") {
    if (!input.browserEndpoint) throw new Error("BrowserOS requires a local endpoint");
    assertLocalBrowserEndpoint(input.browserEndpoint);
  } else if (input.browserEndpoint) throw new Error("Owned browser cannot use a BrowserOS endpoint");
  const preferences = searchPreferencesSchema.parse(JSON.parse(await readPrivateFile(
    join(destination, "search-preferences.json"))));
  const savedPolicy = preferences.applicationPolicy;
  if (input.dailyTarget !== savedPolicy.dailyTarget || input.dailyHardCap !== savedPolicy.dailyHardCap
    || input.requireFinalApproval !== savedPolicy.requireFinalApproval) {
    throw new Error("Daily cap or approval policy differs from the compiled search preferences");
  }
  if (!input.requireFinalApproval) {
    throw new Error("First-run automatic submission requires a configured handoff channel");
  }
  const root = dirname(destination);
  const discoveryInputPath = join(root, "discovery-input.json");
  if (!isAbsolute(queueConfigPath) || [discoveryInputPath, join(root, "application-queue.json"),
    join(root, "discovery-state.json"), join(destination, "candidate-profile.json"),
    join(destination, "search-preferences.json")].some((path) => resolve(path) === resolve(queueConfigPath))) {
    throw new Error("Queue configuration needs a separate absolute private file");
  }
  const config = queueRunnerConfigSchema.parse({ version: 1,
    queuePath: join(root, "application-queue.json"),
    candidatePath: join(destination, "candidate-profile.json"),
    preferencesPath: join(destination, "search-preferences.json"),
    discoveryInputPath, discoveryStatePath: join(root, "discovery-state.json"),
    browserRuntime: input.browserRuntime,
    ...(input.browserEndpoint ? { browserEndpoint: input.browserEndpoint } : {}),
    overleafProjectUrl: input.overleafProjectUrl,
    outputDirectory: join(root, "artifacts"), expectedConfirmationByDomain: {},
  });
  const discovery = discoveryInputSchema.parse({ sources: [officialSource(input.firstSource)],
    includeKeywords: preferences.targetRoles,
    excludeKeywords: preferences.excludeSeniorityTerms,
    preferredFreshnessHours: 48, maximumFreshnessHours: null, maxJobsPerSource: 1000 });
  const configContent = `${JSON.stringify(config, null, 2)}\n`;
  try {
    if (await readPrivateFile(queueConfigPath) !== configContent) {
      throw new Error("Existing private queue configuration differs");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A source file alone cannot start an application. Publish the valid queue
  // config last; a retry after interruption accepts identical source content.
  await createPrivateOutput(discoveryInputPath, `${JSON.stringify(discovery, null, 2)}\n`);
  await createPrivateOutput(queueConfigPath, configContent);
}
