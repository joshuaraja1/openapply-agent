import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** The notification carries no candidate data or application answers. */
export async function notifyHumanHandoff(): Promise<void> {
  if (process.platform !== "darwin") return;
  await exec("osascript", ["-e", 'display notification "An application needs your attention in BrowserOS." with title "OpenApply"']);
}
