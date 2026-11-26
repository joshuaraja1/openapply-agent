import { pathToFileURL } from "node:url";
import { readPrivateFile } from "../storage/private-path.js";
import { installLaunchAgent, removeLaunchAgent, scheduleConfigSchema } from "./launchd.js";
import { installSystemdTimer, removeSystemdTimer } from "./systemd.js";
import { installWindowsTask, removeWindowsTask } from "./windows.js";

export async function runScheduleAction(action: string): Promise<void> {
  if (action === "remove") {
    if (process.platform === "darwin") await removeLaunchAgent();
    else if (process.platform === "linux") await removeSystemdTimer();
    else if (process.platform === "win32") await removeWindowsTask();
    else throw new Error("Local scheduling is unsupported on this platform");
    console.log("OpenApply local schedule removed");
  } else if (action === "install") {
    const configPath = process.env.OPENAPPLY_SCHEDULE_CONFIG;
    if (!configPath) throw new Error("Set OPENAPPLY_SCHEDULE_CONFIG to a private scheduler configuration");
    const config = scheduleConfigSchema.parse(JSON.parse(await readPrivateFile(configPath)));
    const installed = process.platform === "darwin" ? await installLaunchAgent(config)
      : process.platform === "linux" ? await installSystemdTimer(config)
      : process.platform === "win32" ? await installWindowsTask(config)
      : null;
    if (!installed) throw new Error("Local scheduling is unsupported on this platform");
    console.log(`Installed ${installed}`);
  } else throw new Error("Use schedule:install or schedule:remove");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runScheduleAction(process.argv[2] ?? "");
}
