import { execFile } from "node:child_process";
import { lstat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensurePrivateDirectory } from "../storage/private-path.js";
import type { ScheduleConfig } from "./launchd.js";
import { validateSchedule } from "./common.js";

const exec = promisify(execFile);
const taskName = "OpenApplyAgent";
const runnerPath = () => join(userInfo().homedir, ".openapply-agent", "scheduled-run.ps1");

function psLiteral(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Scheduler paths cannot contain control characters");
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsRunner(config: ScheduleConfig, nodePath: string, script: string,
  logs: string): string {
  return `$ErrorActionPreference = 'Stop'\n$env:OPENAPPLY_QUEUE_CONFIG = ${psLiteral(config.queueConfigPath)}\n& ${psLiteral(nodePath)} ${psLiteral(script)} 1>> ${psLiteral(join(logs, "autopilot.out.log"))} 2>> ${psLiteral(join(logs, "autopilot.err.log"))}\nexit $LASTEXITCODE\n`;
}

export function windowsRegistrationScript(config: ScheduleConfig, path: string): string {
  if (/[\r\n\0"]/u.test(path)) throw new Error("Unsupported scheduler path character");
  const argumentsValue = `-NoLogo -NoProfile -NonInteractive -File "${path}"`;
  return `$ErrorActionPreference = 'Stop'
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psLiteral(argumentsValue)}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${config.intervalMinutes}) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
`;
}

export async function installWindowsTask(config: ScheduleConfig, nodePath = process.execPath): Promise<string> {
  if (process.platform !== "win32") throw new Error("Task Scheduler requires Windows");
  const validated = await validateSchedule(config, nodePath);
  const path = runnerPath();
  await ensurePrivateDirectory(join(userInfo().homedir, ".openapply-agent"));
  if (await lstat(path).then(() => true, () => false)) {
    throw new Error("OpenApply schedule already exists; remove it before reinstalling");
  }
  // Query before creation so an unrelated task is never overwritten.
  if (await exec("schtasks.exe", ["/Query", "/TN", taskName]).then(() => true, () => false)) {
    throw new Error("OpenApply Task Scheduler entry already exists");
  }
  await writeFile(path, windowsRunner(validated.config, nodePath, validated.script, validated.logs), { flag: "wx" });
  try {
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      windowsRegistrationScript(validated.config, path)], { timeout: 30_000 });
  } catch (error) {
    await unlink(path);
    throw error;
  }
  return path;
}

export async function removeWindowsTask(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Task Scheduler requires Windows");
  await exec("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
  await unlink(runnerPath());
}
