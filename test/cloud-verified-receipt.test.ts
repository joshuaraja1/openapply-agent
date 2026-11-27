import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CandidateVault, receiptObjectKey } from "../src/cloud/candidate-vault.js";
import { readConfirmedReceipt } from "../src/cloud/verified-receipt.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const receiptId = "00000000-0000-4000-8000-000000000003";
const job = { provider: "Greenhouse", employerId: "acme", requisitionId: "42" };

describe("confirmed receipt reader", () => {
  it("exposes only plaintext matching the durable confirmed digest", async () => {
    const key = randomBytes(32);
    const wrapped = randomBytes(16);
    const objects = new Map<string, Uint8Array>();
    const vault = new CandidateVault({
      async generate() { return { plaintext: Buffer.from(key), wrapped }; },
      async unwrap() { return Buffer.from(key); },
    }, {
      async putCreateOnly(path, body) {
        if (objects.has(path)) throw new Error("duplicate");
        objects.set(path, Buffer.from(body));
      },
      async get(path) { return objects.get(path)!; },
      async purgeVersions() {},
    });
    await vault.putReceipt(candidateId, runId, receiptId, Buffer.from("confirmed"));
    const sha256 = createHash("sha256").update("confirmed").digest("hex");
    const journal = { async readSubmission() {
      return { status: "confirmed" as const, runId, receiptArtifactId: receiptId,
        receiptSha256: sha256 };
    } };
    const result = await readConfirmedReceipt(candidateId, job, journal, vault);
    expect(result.toString()).toBe("confirmed");
    result.fill(0);
    expect(objects.has(receiptObjectKey(candidateId, runId, receiptId))).toBe(true);
    const wrong = { async readSubmission() { return { status: "confirmed" as const,
      runId, receiptArtifactId: receiptId, receiptSha256: "0".repeat(64) }; } };
    await expect(readConfirmedReceipt(candidateId, job, wrong, vault)).rejects.toThrow("digest mismatch");
    const pending = { async readSubmission() { return { status: "needs_reconciliation" as const }; } };
    await expect(readConfirmedReceipt(candidateId, job, pending, vault)).rejects.toThrow("unavailable");
  });
});
