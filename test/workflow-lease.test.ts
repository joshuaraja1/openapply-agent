import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

const exec = promisify(execFile);
const moduleUrl = pathToFileURL(join(import.meta.dirname, "../src/storage/workflow-lease.ts")).href;
const script = `const { holdWorkflowLease } = await import(${JSON.stringify(moduleUrl)});
  await holdWorkflowLease(process.argv[1]); console.log("ready");
  if (process.argv[2] === "hold") process.stdin.resume();`;

describe("workflow maintenance lease", () => {
  it("fences a second process until the first command exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-workflow-"));
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const first = spawn(process.execPath, ["--import", "tsx", "--eval", script, root, "hold"],
      { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        first.once("error", reject);
        first.stdout!.once("data", (chunk: Buffer) => {
          if (String(chunk).includes("ready")) resolve();
          else reject(new Error("Lease holder did not start"));
        });
        first.once("exit", (code) => reject(new Error(`Lease holder exited early: ${code}`)));
      });
      await expect(exec(process.execPath, ["--import", "tsx", "--eval", script, root]))
        .rejects.toThrow("Another workflow is active");
      first.stdin!.end();
      await new Promise<void>((resolve) => first.once("exit", () => resolve()));
      expect((await exec(process.execPath, ["--import", "tsx", "--eval", script, root])).stdout)
        .toContain("ready");
    } finally {
      if (!first.killed) first.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
