import { z } from "zod";
import { isAbsolute } from "node:path";

const absolutePath = z.string().min(1).refine(isAbsolute, "Use an absolute path");

export const queueRunnerConfigSchema = z.object({
  version: z.literal(1), queuePath: absolutePath, candidatePath: absolutePath,
  preferencesPath: absolutePath, discoveryInputPath: absolutePath,
  discoveryStatePath: absolutePath, browserEndpoint: z.url(),
  overleafProjectUrl: z.url(), outputDirectory: absolutePath,
  expectedConfirmationByDomain: z.record(z.string(), z.string().min(1)).default({}),
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
