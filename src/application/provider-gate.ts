import type { Provider } from "../types.js";
import { readPrivateFile } from "../storage/private-path.js";
import { queueRunnerConfigSchema } from "./queue-config.js";
import type { z } from "zod";

/** A configured discovery source never authorizes scheduled application execution. */
export function providerPauseReason(provider: Provider, allowlist: readonly Provider[]): string | undefined {
  return allowlist.includes(provider) ? undefined
    : `Scheduled applications for ${provider} are paused; enable this provider in the private queue policy after its beta gate passes`;
}

/** Re-read the private policy for every queued job; any mid-run edit requires restart. */
export async function currentProviderPauseReason(configPath: string,
  initial: z.infer<typeof queueRunnerConfigSchema>, provider: Provider): Promise<string | undefined> {
  const current = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(configPath)));
  if (JSON.stringify(current) !== JSON.stringify(initial)) {
    return "Private queue policy changed during this run; restart before applying";
  }
  return providerPauseReason(provider, current.queueProviderAllowlist);
}
