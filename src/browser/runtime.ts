import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, type BrowserContext } from "playwright";

export interface BrowserRuntime {
  context: BrowserContext;
  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  profileDirectory: string;
  headless?: boolean;
  launch?: typeof chromium.launchPersistentContext;
}

async function acquireProfileLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(lockPath, "wx", 0o600);
      try {
        await file.writeFile(String(process.pid));
      } finally {
        await file.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number((await readFile(lockPath, "utf8")).trim());
      if (!Number.isSafeInteger(owner) || owner < 1) {
        throw new Error("Browser profile lock is invalid; inspect it before recovery");
      }
      try {
        process.kill(owner, 0);
        throw new Error(`Browser profile is already in use by process ${owner}`);
      } catch (checkError) {
        if ((checkError as NodeJS.ErrnoException).code !== "ESRCH") throw checkError;
        await unlink(lockPath);
      }
    }
  }
  throw new Error("Browser profile could not be locked");
}

export async function launchBrowser(options: BrowserLaunchOptions): Promise<BrowserRuntime> {
  const profileDirectory = resolve(options.profileDirectory);
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(profileDirectory, ".openapply.lock");
  await acquireProfileLock(lockPath);
  let context: BrowserContext;
  try {
    const launchOptions = {
      headless: options.headless ?? false,
      acceptDownloads: true,
    };
    context = options.launch
      ? await options.launch(profileDirectory, launchOptions)
      : await chromium.launchPersistentContext(profileDirectory, launchOptions);
  } catch (error) {
    await unlink(lockPath);
    throw error;
  }
  return {
    context,
    async close() {
      try {
        await context.close();
      } finally {
        await unlink(lockPath);
      }
    },
  };
}
