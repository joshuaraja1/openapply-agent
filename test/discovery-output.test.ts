import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistDiscoveryOutput } from "../src/storage/discovery-output.js";

describe("discovery persistence order", () => {
  it("writes the recoverable queue before reported state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-persist-"));
    try {
      const outputPath = join(root, "queue.json");
      const invalidStatePath = root;
      await expect(persistDiscoveryOutput(outputPath, { queue: [{ job: { id: "one" } }] },
        invalidStatePath, { jobs: {} })).rejects.toThrow();
      expect(JSON.parse(await readFile(outputPath, "utf8")).queue[0].job.id).toBe("one");
      await expect(persistDiscoveryOutput(outputPath, {}, outputPath, {})).rejects.toThrow("separate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
