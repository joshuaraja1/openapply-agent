import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { queueRunnerConfigSchema } from "../application/queue-config.js";

const exec = promisify(execFile);
const label = "com.openapply.agent";
const absolutePath = z.string().min(1).refine(isAbsolute, "Use an absolute path");
export const scheduleConfigSchema = z.object({
  version: z.literal(1), repositoryPath: absolutePath,
  queueConfigPath: absolutePath,
  intervalMinutes: z.number().int().min(30).max(1440),
});
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function launchAgentPlist(config: ScheduleConfig, nodePath: string, logsDirectory: string): string {
  const parsed = scheduleConfigSchema.parse(config);
  if (!isAbsolute(nodePath) || !isAbsolute(logsDirectory)) throw new Error("Scheduler paths must be absolute");
  const script = join(parsed.repositoryPath, "dist", "src", "application", "autopilot-cli.js");
  const environment = { OPENAPPLY_QUEUE_CONFIG: parsed.queueConfigPath };
  const entries = Object.entries(environment)
    .map(([key, value]) => `      <key>${key}</key><string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(script)}</string></array>
  <key>WorkingDirectory</key><string>${xml(parsed.repositoryPath)}</string>
  <key>EnvironmentVariables</key><dict>
${entries}
  </dict>
  <key>StartInterval</key><integer>${parsed.intervalMinutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logsDirectory, "autopilot.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logsDirectory, "autopilot.err.log"))}</string>
</dict></plist>
`;
}

function agentPath(): string {
  return join(userInfo().homedir, "Library", "LaunchAgents", `${label}.plist`);
}

export async function installLaunchAgent(config: ScheduleConfig, nodePath = process.execPath): Promise<string> {
  if (process.platform !== "darwin") throw new Error("The local scheduler currently supports macOS LaunchAgents");
  const parsed = scheduleConfigSchema.parse(config);
  const repository = await stat(parsed.repositoryPath);
  const script = await stat(join(parsed.repositoryPath, "dist", "src", "application", "autopilot-cli.js"));
  if (!repository.isDirectory() || !script.isFile()) throw new Error("Build the project before installing the scheduler");
  const queueConfig = queueRunnerConfigSchema.parse(JSON.parse(await readFile(parsed.queueConfigPath, "utf8")));
  for (const path of [queueConfig.discoveryInputPath, queueConfig.candidatePath,
    queueConfig.preferencesPath, parsed.queueConfigPath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()
      || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
      throw new Error("Scheduler input files must be private to this user");
    }
  }
  const logs = join(userInfo().homedir, ".openapply-agent", "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const info = await lstat(logs);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new Error("Scheduler logs directory must be private to this user");
  }
  const path = agentPath();
  await mkdir(join(userInfo().homedir, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(path, launchAgentPlist(parsed, resolve(nodePath), logs), { flag: "wx", mode: 0o600 });
  try {
    await exec("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
  } catch (error) {
    await unlink(path);
    throw error;
  }
  return path;
}

export async function removeLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("The local scheduler currently supports macOS LaunchAgents");
  const path = agentPath();
  await exec("launchctl", ["bootout", `gui/${process.getuid!()}`, path]);
  await unlink(path);
}
