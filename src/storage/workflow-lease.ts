import { mkdir, rmdir } from "node:fs/promises";
import { rmdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { ensurePrivateDirectory } from "./private-path.js";
import { secureWindowsPrivatePath } from "./windows-acl.js";

const defaultRoot = join(userInfo().homedir, ".openapply-agent");
let heldPath: string | undefined;

/** Recovery may inspect an interrupted final click only under this process's exclusive workflow lease. */
export function assertWorkflowLeaseHeld(root = defaultRoot): void {
  if (heldPath !== join(resolve(root), "workflow.lock")) {
    throw new Error("Submission recovery requires the exclusive workflow lease");
  }
}

/** Hold a process-wide lease across every workflow command, including cutover. */
export async function holdWorkflowLease(root = defaultRoot): Promise<void> {
  const path = join(resolve(root), "workflow.lock");
  if (heldPath === path) return; // autopilot imports discovery and queue in this process
  if (heldPath) throw new Error("This process already holds a workflow lease for another state directory");
  await ensurePrivateDirectory(resolve(root));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another workflow is active, or its lock needs inspection after a crash");
    }
    throw error;
  }
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(path);
  } catch (error) {
    await rmdir(path);
    throw error;
  }
  heldPath = path;
  // CLI modules do not share a single outer finally; release only when every
  // imported command has finished and the process actually exits.
  process.once("exit", () => {
    try { rmdirSync(path); } catch { /* keep the lock for manual crash inspection */ }
    heldPath = undefined;
  });
}
