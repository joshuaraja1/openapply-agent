import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { assertWindowsPrivatePath, secureWindowsPrivatePath } from "./windows-acl.js";
import { ensurePrivateDirectory } from "./private-path.js";

/** Publish a complete file without overwriting a different existing version. */
export async function createPrivateOutput(path: string, content: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const existing = async (): Promise<boolean> => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
      || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("Existing private output has unsafe permissions");
    }
    if (process.platform === "win32") await assertWindowsPrivatePath(path);
    if (await readFile(path, "utf8") !== content) {
      throw new Error("Existing private output differs; move it before recompiling");
    }
    return true;
  };
  try {
    if (await existing()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(temporary);
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await existing())) throw error;
    }
    if (process.platform === "win32") await assertWindowsPrivatePath(path);
    else {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
