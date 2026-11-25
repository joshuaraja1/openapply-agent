import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ApplicationStateStore } from "./contracts.js";
import { assertWindowsPrivatePath, ensureWindowsPrivateDirectory, secureWindowsPrivatePath }
  from "./windows-acl.js";

interface StoredRecord<State> {
  version: number;
  state?: State;
}

interface SealedData {
  nonce: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedApplicationStateStore<State> implements ApplicationStateStore<State> {
  private readonly path: string;
  private readonly key: Buffer;

  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) throw new Error("Application state encryption requires a 256-bit key");
    this.path = resolve(path);
    this.key = Buffer.from(key);
  }

  async read(applicationId: string): Promise<{ version: number; state: State } | undefined> {
    const records = await this.load();
    const record = records[applicationId];
    return record?.state === undefined ? undefined : { version: record.version, state: record.state };
  }

  async compareAndSwap(
    applicationId: string,
    expectedVersion: number | undefined,
    state: State,
  ): Promise<number | undefined> {
    return this.withLock(async () => {
      const records = await this.load();
      const current = records[applicationId];
      if ((current?.state === undefined ? undefined : current.version) !== expectedVersion) return undefined;
      const version = (current?.version ?? 0) + 1;
      records[applicationId] = { version, state };
      await this.save(records);
      return version;
    });
  }

  async delete(applicationId: string, expectedVersion: number): Promise<boolean> {
    return this.withLock(async () => {
      const records = await this.load();
      const current = records[applicationId];
      if (current?.state === undefined || current.version !== expectedVersion) return false;
      records[applicationId] = { version: current.version };
      await this.save(records);
      return true;
    });
  }

  /** Call only after an operator has confirmed no process is using this state file. */
  async recoverLockAfterInspection(confirmedInactive: true): Promise<void> {
    if (confirmedInactive !== true) throw new Error("Recovery requires explicit inactivity confirmation");
    if (process.platform === "win32") await assertWindowsPrivatePath(`${this.path}.lock`);
    await rmdir(`${this.path}.lock`);
  }

  private async withLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    const directory = dirname(this.path);
    if (process.platform === "win32") {
      try {
        if (directory === resolve(join(userInfo().homedir, ".openapply-agent"))) {
          await ensureWindowsPrivateDirectory(directory);
        } else {
          await assertWindowsPrivatePath(directory);
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("Windows custom state directory must exist with a private ACL");
        }
        throw error;
      }
    }
    else await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await stat(directory);
    if (process.getuid && metadata.uid !== process.getuid()) throw new Error("State directory has another owner");
    if (process.platform === "win32") await assertWindowsPrivatePath(directory);
    else if ((metadata.mode & 0o077) !== 0) throw new Error("State directory must be private");
    const lock = `${this.path}.lock`;
    await mkdir(lock, { mode: 0o700 });
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(lock);
      return await operation();
    } finally {
      await rmdir(lock);
    }
  }

  private async load(): Promise<Record<string, StoredRecord<State>>> {
    let raw: string;
    try {
      if (process.platform === "win32") {
        await assertWindowsPrivatePath(dirname(this.path));
        await assertWindowsPrivatePath(this.path);
      }
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
      throw error;
    }
    const sealed = JSON.parse(raw) as SealedData;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const parsed = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")) as Record<string, StoredRecord<State>>;
    return Object.assign(Object.create(null) as Record<string, StoredRecord<State>>, parsed);
  }

  private async save(records: Record<string, StoredRecord<State>>): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(records), "utf8"), cipher.final()]);
    const sealed: SealedData = {
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(sealed));
        await file.sync();
      } finally {
        await file.close();
      }
      if (process.platform === "win32") await secureWindowsPrivatePath(temporary);
      await rename(temporary, this.path);
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.path), "r");
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
}
