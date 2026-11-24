import { z } from "zod";

export const queueRunnerConfigSchema = z.object({
  version: z.literal(1), queuePath: z.string().min(1), candidatePath: z.string().min(1),
  preferencesPath: z.string().min(1), discoveryInputPath: z.string().min(1),
  discoveryStatePath: z.string().min(1), browserEndpoint: z.url(),
  overleafProjectUrl: z.url(), outputDirectory: z.string().min(1),
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
