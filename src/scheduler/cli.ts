import { readFile } from "node:fs/promises";
import { installLaunchAgent, removeLaunchAgent, scheduleConfigSchema } from "./launchd.js";

const action = process.argv[2];
if (action === "remove") {
  await removeLaunchAgent();
  console.log("OpenApply LaunchAgent removed");
} else if (action === "install") {
  const configPath = process.env.OPENAPPLY_SCHEDULE_CONFIG;
  if (!configPath) throw new Error("Set OPENAPPLY_SCHEDULE_CONFIG to a private scheduler configuration");
  const config = scheduleConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  console.log(`Installed ${await installLaunchAgent(config)}`);
} else {
  throw new Error("Use schedule:install or schedule:remove");
}
