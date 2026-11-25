import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertPrivateFile, ensurePrivateDirectory } from "./private-path.js";
import { secureWindowsPrivatePath } from "./windows-acl.js";

async function atomicJson(path: string, value: unknown): Promise<void> {
  const destination = resolve(path);
  await ensurePrivateDirectory(dirname(destination));
  try {
    await assertPrivateFile(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(temporary);
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    await assertPrivateFile(destination);
    if (process.platform !== "win32") {
      const directory = await open(dirname(destination), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function persistDiscoveryOutput(
  outputPath: string, output: unknown, statePath: string, state: unknown,
): Promise<void> {
  if (resolve(outputPath) === resolve(statePath)) throw new Error("Queue and discovery state need separate files");
  // State may mark jobs reported only after the recoverable queue is durable.
  await atomicJson(outputPath, output);
  await atomicJson(statePath, state);
}
