import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertWindowsPrivatePath, ensureWindowsPrivateDirectory } from "./windows-acl.js";

export async function assertPrivateFile(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Private input needs an absolute path");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("Private input must be a regular file owned by this user");
  }
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(dirname(path));
    await assertWindowsPrivatePath(path);
  }
  else if ((info.mode & 0o077) !== 0) throw new Error("Private input has unsafe permissions");
}

/** Read through the same file handle whose identity was ACL checked by path. */
export function assertSameFileIdentity(pinned: Pick<Stats, "dev" | "ino">,
  named: Pick<Stats, "dev" | "ino">): void {
  if (!pinned.ino || !named.ino || pinned.dev !== named.dev || pinned.ino !== named.ino) {
    throw new Error("Private input changed during ACL verification");
  }
}

export async function readPrivateFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Private input needs an absolute path");
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  try {
    const pinned = await handle.stat();
    await assertPrivateFile(path);
    const named = await lstat(path);
    if (!pinned.isFile() || named.isSymbolicLink()) {
      throw new Error("Private input changed during ACL verification");
    }
    assertSameFileIdentity(pinned, named);
    return await handle.readFile({ encoding: "utf8" });
  } finally { await handle.close(); }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Private output needs an absolute directory path");
  const directory = resolve(path);
  if (process.platform === "win32") {
    if (directory !== resolve(join(userInfo().homedir, ".openapply-agent"))) {
      await assertWindowsPrivatePath(dirname(directory));
    }
    await ensureWindowsPrivateDirectory(directory);
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
      throw new Error("Private output directory has unsafe permissions");
    }
  }
}
