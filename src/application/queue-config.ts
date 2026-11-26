import { z } from "zod";
import { isAbsolute } from "node:path";

const absolutePath = z.string().min(1).refine(isAbsolute, "Use an absolute path");

export const queueRunnerConfigSchema = z.object({
  version: z.literal(1), queuePath: absolutePath, candidatePath: absolutePath,
  preferencesPath: absolutePath, discoveryInputPath: absolutePath,
  discoveryStatePath: absolutePath,
  browserRuntime: z.enum(["browseros", "owned"]).default("browseros"),
  browserEndpoint: z.url().optional(),
  authenticationPolicyPath: absolutePath.optional(),
  notificationConfigPath: absolutePath.optional(),
  overleafProjectUrl: z.url(), outputDirectory: absolutePath,
  // Explicit local beta policy. Legacy configurations parse to an empty list.
  queueProviderAllowlist: z.array(z.enum(["greenhouse", "ashby", "lever", "smartrecruiters",
    "workday", "jsonld"])).max(6).default([]),
  expectedConfirmationByDomain: z.record(z.string(), z.string().min(1)).default({}),
}).superRefine((config, context) => {
  if (config.browserRuntime === "browseros" && !config.browserEndpoint) {
    context.addIssue({ code: "custom", path: ["browserEndpoint"],
      message: "BrowserOS queue runtime requires a local endpoint" });
  }
  if (config.browserRuntime === "owned" && config.browserEndpoint) {
    context.addIssue({ code: "custom", path: ["browserEndpoint"],
      message: "Owned queue runtime cannot use a BrowserOS endpoint" });
  }
});

export function setDiscoveryEnvironment(
  config: z.infer<typeof queueRunnerConfigSchema>, environment: NodeJS.ProcessEnv,
): void {
  environment.OPENAPPLY_INPUT = config.discoveryInputPath;
  environment.OPENAPPLY_CANDIDATE = config.candidatePath;
  environment.OPENAPPLY_PREFERENCES = config.preferencesPath;
  environment.OPENAPPLY_STATE = config.discoveryStatePath;
  environment.OPENAPPLY_OUTPUT = config.queuePath;
}
