import { execFile } from "node:child_process";
import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScheduleConfig } from "./launchd.js";
import { validateSchedule } from "./common.js";

const exec = promisify(execFile);
const name = "openapply-agent";
const unitDirectory = () => join(userInfo().homedir, ".config", "systemd", "user");

function unitValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Scheduler paths cannot contain control characters");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function systemdUnits(config: ScheduleConfig, nodePath: string, script: string,
  logs: string): { service: string; timer: string } {
  const service = `[Unit]\nDescription=OpenApply local autopilot\n\n[Service]\nType=oneshot\nWorkingDirectory=${unitValue(config.repositoryPath)}\nEnvironment=${unitValue(`OPENAPPLY_QUEUE_CONFIG=${config.queueConfigPath}`)}\nExecStart=${unitValue(nodePath)} ${unitValue(script)}\nStandardOutput=append:${unitValue(join(logs, "autopilot.out.log"))}\nStandardError=append:${unitValue(join(logs, "autopilot.err.log"))}\n`;
  const timer = `[Unit]\nDescription=Run OpenApply on a local schedule\n\n[Timer]\nOnStartupSec=1min\nOnUnitInactiveSec=${config.intervalMinutes}min\nUnit=${name}.service\n\n[Install]\nWantedBy=timers.target\n`;
  return { service, timer };
}

export async function installSystemdTimer(config: ScheduleConfig, nodePath = process.execPath): Promise<string> {
  if (process.platform !== "linux") throw new Error("systemd user timers require Linux");
  const validated = await validateSchedule(config, nodePath);
  const directory = unitDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const service = join(directory, `${name}.service`);
  const timer = join(directory, `${name}.timer`);
  if (await Promise.all([service, timer].map(async (path) => await lstat(path).then(() => true, () => false))).then((found) => found.some(Boolean))) {
    throw new Error("OpenApply schedule already exists; remove it before reinstalling");
  }
  const units = systemdUnits(validated.config, nodePath, validated.script, validated.logs);
  await writeFile(service, units.service, { flag: "wx", mode: 0o600 });
  let timerCreated = false;
  try {
    await writeFile(timer, units.timer, { flag: "wx", mode: 0o600 });
    timerCreated = true;
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "--now", `${name}.timer`]);
  } catch (error) {
    if (timerCreated) {
      await exec("systemctl", ["--user", "disable", "--now", `${name}.timer`]).catch(() => {});
      await unlink(timer).catch(() => {});
    }
    await unlink(service).catch(() => {});
    await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    throw error;
  }
  return timer;
}

export async function removeSystemdTimer(): Promise<void> {
  if (process.platform !== "linux") throw new Error("systemd user timers require Linux");
  await exec("systemctl", ["--user", "disable", "--now", `${name}.timer`]);
  await unlink(join(unitDirectory(), `${name}.timer`));
  await unlink(join(unitDirectory(), `${name}.service`));
  await exec("systemctl", ["--user", "daemon-reload"]);
}
