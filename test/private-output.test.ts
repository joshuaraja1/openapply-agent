import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPrivateOutput } from "../src/storage/private-output.js";

describe("private output publication", () => {
  it("publishes complete content and supports a restart with identical data", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-output-"));
    try {
      const path = join(root, "candidate.json");
      await createPrivateOutput(path, "first\n");
      await createPrivateOutput(path, "first\n");
      expect(await readFile(path, "utf8")).toBe("first\n");
      expect((await lstat(path)).mode & 0o077).toBe(0);
      await expect(createPrivateOutput(path, "changed\n")).rejects.toThrow("differs");
      expect(await readFile(path, "utf8")).toBe("first\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
