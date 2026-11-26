import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { userInfo } from "node:os";
import { queueRunnerConfigSchema } from "../application/queue-config.js";
import { assertPrivateFile, ensurePrivateDirectory, readPrivateFile } from "../storage/private-path.js";
import { scheduleConfigSchema, type ScheduleConfig } from "./launchd.js";

export function autopilotScript(config: ScheduleConfig): string {
  return join(config.repositoryPath, "dist", "src", "application", "autopilot-cli.js");
}

export async function validateSchedule(config: ScheduleConfig, nodePath: string): Promise<{
  config: ScheduleConfig; script: string; logs: string;
}> {
  const parsed = scheduleConfigSchema.parse(config);
  if (!isAbsolute(nodePath)) throw new Error("Node executable must be an absolute path");
  const repository = await stat(parsed.repositoryPath);
  const script = autopilotScript(parsed);
  if (!repository.isDirectory() || !(await stat(script)).isFile() || !(await stat(nodePath)).isFile()) {
    throw new Error("Build the project and provide an absolute Node executable before scheduling");
  }
  const queue = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(parsed.queueConfigPath)));
  for (const path of [queue.discoveryInputPath, queue.candidatePath, queue.preferencesPath]) {
    await assertPrivateFile(path);
  }
  const logs = join(userInfo().homedir, ".openapply-agent", "logs");
  await ensurePrivateDirectory(logs);
  return { config: parsed, script, logs };
}
