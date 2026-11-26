import { execFile } from "node:child_process";
import { lstat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensurePrivateDirectory, readPrivateFile } from "../storage/private-path.js";
import { secureWindowsPrivatePath } from "../storage/windows-acl.js";
import type { ScheduleConfig } from "./launchd.js";
import { validateSchedule } from "./common.js";

const exec = promisify(execFile);
const taskName = "OpenApplyAgent";
const marker = "# OpenApply managed schedule v1";
const runnerPath = () => join(userInfo().homedir, ".openapply-agent", "scheduled-run.ps1");

function psLiteral(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Scheduler paths cannot contain control characters");
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsRunner(config: ScheduleConfig, nodePath: string, script: string,
  logs: string): string {
  return `${marker}\n$ErrorActionPreference = 'Stop'\n$env:OPENAPPLY_QUEUE_CONFIG = ${psLiteral(config.queueConfigPath)}\n& ${psLiteral(nodePath)} ${psLiteral(script)} 1>> ${psLiteral(join(logs, "autopilot.out.log"))} 2>> ${psLiteral(join(logs, "autopilot.err.log"))}\nexit $LASTEXITCODE\n`;
}

function actionArguments(path: string): string {
  if (/[\r\n\0"]/u.test(path)) throw new Error("Unsupported scheduler path character");
  return `-NoLogo -NoProfile -NonInteractive -File "${path}"`;
}

export function windowsRegistrationScript(config: ScheduleConfig, path: string): string {
  const argumentsValue = actionArguments(path);
  return `$ErrorActionPreference = 'Stop'
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psLiteral(argumentsValue)}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${config.intervalMinutes}) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
`;
}

export function windowsRemovalScript(path: string): string {
  return `$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop
if (@($task.Actions).Count -ne 1 -or [IO.Path]::GetFileName($task.Actions[0].Execute) -ne 'powershell.exe' -or
    $task.Actions[0].Arguments -ne ${psLiteral(actionArguments(path))} -or
    $task.Principal.LogonType -ne 'Interactive') {
  throw 'Refusing to remove a task not managed by OpenApply'
}
Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction Stop
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
    await secureWindowsPrivatePath(path);
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
  const path = runnerPath();
  if (!(await readPrivateFile(path)).startsWith(`${marker}\n`)) {
    throw new Error("Refusing to remove a runner not managed by OpenApply");
  }
  await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsRemovalScript(path)],
    { timeout: 30_000 });
  await unlink(path);
}
