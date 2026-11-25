import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { assertWindowsPrivatePath, ensureWindowsPrivateDirectory, secureWindowsPrivatePath }
  from "../storage/windows-acl.js";

export interface BrowserRuntime {
  context: BrowserContext;
  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  profileDirectory: string;
  headless?: boolean;
  launch?: typeof chromium.launchPersistentContext;
}

export async function launchBrowser(options: BrowserLaunchOptions): Promise<BrowserRuntime> {
  const profileDirectory = resolve(options.profileDirectory);
  if (process.platform === "win32") {
    await ensureWindowsPrivateDirectory(dirname(profileDirectory));
    await ensureWindowsPrivateDirectory(profileDirectory);
  } else {
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  }
  const parent = await lstat(dirname(profileDirectory));
  const profile = await lstat(profileDirectory);
  if (!profile.isDirectory() || profile.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("Browser profile and parent paths must be real directories");
  }
  if (process.getuid && (profile.uid !== process.getuid() || parent.uid !== process.getuid())) {
    throw new Error("Browser profile and parent directories must belong to the current user");
  }
  if (process.platform !== "win32" && ((profile.mode | parent.mode) & 0o077) !== 0) {
    throw new Error("Browser profile and parent directories must be private to the current user");
  }
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(dirname(profileDirectory));
    await assertWindowsPrivatePath(profileDirectory);
  }
  const lockDirectory = `${profileDirectory}.lock`;
  await mkdir(lockDirectory, { mode: 0o700 });
  const release = () => rmdir(lockDirectory);
  let context: BrowserContext;
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(lockDirectory);
    const launchOptions = {
      headless: options.headless ?? false,
      acceptDownloads: true,
    };
    context = options.launch
      ? await options.launch(profileDirectory, launchOptions)
      : await chromium.launchPersistentContext(profileDirectory, launchOptions);
  } catch (error) {
    await release();
    throw error;
  }
  let closed = false;
  return {
    context,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await context.close();
      } finally {
        await release();
      }
    },
  };
}
