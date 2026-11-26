import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { assertWindowsPrivatePath, ensureWindowsPrivateDirectory, secureWindowsPrivatePath }
  from "../storage/windows-acl.js";

export interface BrowserRuntime {
  context: BrowserContext;
  close(): Promise<void>;
}

const blockedServiceWorkerContexts = new WeakSet<BrowserContext>();

/** Only contexts launched here with service workers disabled may back the owner proxy. */
export function assertServiceWorkersBlocked(context: BrowserContext): void {
  if (!blockedServiceWorkerContexts.has(context)) {
    throw new Error("Owner browser must block service workers at launch");
  }
}

export interface BrowserLaunchOptions {
  profileDirectory: string;
  headless?: boolean;
  serviceWorkers?: "allow" | "block";
  launch?: typeof chromium.launchPersistentContext;
}

interface LockOwner { pid: number; token: string }

async function readLockOwner(path: string): Promise<LockOwner> {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 512) {
    throw new Error("Browser profile lock owner file is unsafe");
  }
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || !Number.isSafeInteger((value as LockOwner).pid)
    || typeof (value as LockOwner).token !== "string"
    || (value as LockOwner).token.length < 8) {
    throw new Error("Browser profile lock owner is invalid");
  }
  return value as LockOwner;
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function acquireProfileLock(path: string): Promise<() => Promise<void>> {
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const observed = await lstat(path);
    if (!observed.isDirectory() || observed.isSymbolicLink()) throw new Error("Browser profile lock is unsafe");
    let previous: LockOwner;
    try {
      previous = await readLockOwner(join(path, "owner.json"));
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() - observed.mtimeMs < 300_000) {
        throw new Error("Browser profile lock needs manual inspection");
      }
      previous = { pid: -1, token: "missing-owner" };
    }
    const missingOwner = previous.token === "missing-owner";
    if ((!missingOwner && previous.pid < 1) || (previous.pid > 0 && isRunning(previous.pid))) {
      throw new Error("Browser profile is already locked or lock owner is invalid");
    }
    const claim = join(path, "recovering");
    await mkdir(claim, { mode: 0o700 });
    try {
      const latest = await lstat(path);
      if (latest.ino !== observed.ino || latest.dev !== observed.dev) {
        throw new Error("Browser profile lock changed during recovery");
      }
      const currentOwner = await readLockOwner(join(path, "owner.json"))
        .catch((readError: unknown) => {
          if (previous.token === "missing-owner"
            && (readError as NodeJS.ErrnoException).code === "ENOENT") return previous;
          throw new Error("Browser profile lock changed during recovery");
        });
      if (currentOwner.pid !== previous.pid || currentOwner.token !== previous.token) {
        throw new Error("Browser profile lock changed during recovery");
      }
      const stale = `${path}.stale-${randomUUID()}`;
      await rename(path, stale);
      await rm(stale, { recursive: true });
    } catch (recoveryError) {
      await rmdir(claim).catch(() => {});
      throw recoveryError;
    }
    await mkdir(path, { mode: 0o700 });
  }
  const ownerPath = join(path, "owner.json");
  try {
    if (process.platform === "win32") await secureWindowsPrivatePath(path);
    await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") await secureWindowsPrivatePath(ownerPath);
  } catch (error) {
    await unlink(ownerPath).catch(() => {});
    await rmdir(path).catch(() => {});
    throw error;
  }
  return async () => {
    const current = await readLockOwner(ownerPath);
    if (current.pid !== owner.pid || current.token !== owner.token) {
      throw new Error("Browser profile lock ownership changed");
    }
    await unlink(ownerPath);
    await rmdir(path);
  };
}

export async function launchBrowser(options: BrowserLaunchOptions): Promise<BrowserRuntime> {
  const profileDirectory = resolve(options.profileDirectory);
  if (process.platform === "win32") {
    const parentDirectory = dirname(profileDirectory);
    try {
      if (parentDirectory === resolve(join(userInfo().homedir, ".openapply-agent"))) {
        await ensureWindowsPrivateDirectory(parentDirectory);
      } else {
        await assertWindowsPrivatePath(parentDirectory);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Windows custom browser profile parent must exist with a private ACL");
      }
      throw error;
    }
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
  const release = await acquireProfileLock(lockDirectory);
  let context: BrowserContext;
  try {
    const launchOptions = {
      headless: options.headless ?? false,
      acceptDownloads: true,
      serviceWorkers: options.serviceWorkers ?? "allow",
    };
    context = options.launch
      ? await options.launch(profileDirectory, launchOptions)
      : await chromium.launchPersistentContext(profileDirectory, launchOptions);
  } catch (error) {
    await release();
    throw error;
  }
  let closed = false;
  if (options.serviceWorkers === "block") blockedServiceWorkerContexts.add(context);
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
