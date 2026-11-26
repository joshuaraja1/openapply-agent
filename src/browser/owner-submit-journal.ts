import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OwnerClaimBinding } from "./owner-protocol.js";
import { z } from "zod";

const intentSchema = z.object({ version: z.literal(1), binding: z.object({
  tabId: z.uuid(), claimId: z.uuid(), jobId: z.string().min(1).max(256),
  officialUrl: z.url(), packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict(), preSubmitUrl: z.url(), receiptPolicySha256: z.string().regex(/^[a-f0-9]{64}$/),
  submittedAt: z.iso.datetime() }).strict();

export interface OwnerReceiptPolicy {
  company: string;
  role: string;
  phrase: string;
  postUrl: string;
  postFields: Record<string, string>;
}

export function receiptPolicySha256(policy: OwnerReceiptPolicy): string {
  const fields = Object.entries(policy.postFields).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({ company: policy.company.trim(),
    role: policy.role.trim(), phrase: policy.phrase.trim(), postUrl: new URL(policy.postUrl).href,
    postFields: fields })).digest("hex");
}

export interface OwnerSubmitIntent {
  version: 1;
  binding: OwnerClaimBinding;
  preSubmitUrl: string;
  receiptPolicySha256: string;
  submittedAt: string;
}

function pathFor(directory: string, claimId: string): string {
  z.uuid().parse(claimId);
  return join(directory, `${createHash("sha256").update(claimId).digest("hex")}.json`);
}

/** A claim is deliberately never cleared or retried, including after owner death. */
export class OwnerSubmitJournal {
  constructor(private readonly directory: string) {}

  private async assertPrivateDirectory(): Promise<void> {
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (process.getuid && directory.uid !== process.getuid())
      || (directory.mode & 0o077) !== 0) {
      throw new Error("Submit journal must be a private directory owned by the user");
    }
  }

  async read(claimId: string): Promise<OwnerSubmitIntent | undefined> {
    await this.assertPrivateDirectory();
    const path = pathFor(this.directory, claimId);
    let raw: string;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const entry = await file.stat();
        if (!entry.isFile() || entry.size > 4096 || (entry.mode & 0o077) !== 0) {
          throw new Error("Submit journal entry is unsafe");
        }
        raw = await file.readFile({ encoding: "utf8" });
      } finally { await file.close(); }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const intent = intentSchema.parse(JSON.parse(raw) as unknown);
    if (intent.version !== 1 || intent.binding.claimId !== claimId) {
      throw new Error("Submit journal entry is invalid");
    }
    return intent;
  }

  async claim(binding: OwnerClaimBinding, preSubmitUrl: string,
    policySha256: string): Promise<OwnerSubmitIntent> {
    await this.assertPrivateDirectory();
    const path = pathFor(this.directory, binding.claimId);
    const intent: OwnerSubmitIntent = { version: 1, binding: { ...binding },
      preSubmitUrl, receiptPolicySha256: policySha256,
      submittedAt: new Date().toISOString() };
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(intent));
      await file.sync();
    } finally { await file.close(); }
    // A successful return means both the intent and its directory entry have
    // reached storage before the owner is allowed to dispatch a final click.
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return intent;
  }
}
