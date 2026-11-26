import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OwnerSubmitJournal } from "../src/browser/owner-submit-journal.js";

const hash = "a".repeat(64);
describe.skipIf(process.platform === "win32")("owner final-click journal", () => {
  it("makes one durable, private intent and rejects a second claim after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-owner-journal-"));
    const binding = { tabId: randomUUID(), claimId: randomUUID(), jobId: "example:123456",
      officialUrl: "https://jobs.example.test/123456", packageSha256: hash,
      artifactSha256: hash };
    try {
      const first = new OwnerSubmitJournal(directory);
      const saved = await first.claim(binding, binding.officialUrl, "b".repeat(64));
      expect(saved.binding).toEqual(binding);
      const restarted = new OwnerSubmitJournal(directory);
      expect(await restarted.read(binding.claimId)).toEqual(saved);
      await expect(restarted.claim(binding, binding.officialUrl, "b".repeat(64)))
        .rejects.toMatchObject({ code: "EEXIST" });
      const files = await import("node:fs/promises").then((fs) => fs.readdir(directory));
      expect(files).toHaveLength(1);
      expect(await readFile(join(directory, files[0]!), "utf8")).toContain(binding.claimId);
    } finally { await rm(directory, { recursive: true }); }
  });
});
