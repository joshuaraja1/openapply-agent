import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchBrowser } from "../src/browser/runtime.js";
import { withOwnedReceiptPrompt } from "../src/application/owned-confirm-session.js";

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("owned receipt prompt lifecycle", () => {
  it("times out, closes Chromium, and releases the profile for the next queue run", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-owned-prompt-"));
    const profileDirectory = join(root, "profile");
    const runtime = await launchBrowser({ profileDirectory, headless: true });
    const close = vi.fn();
    const finalize = vi.fn(async () => "submitted");
    const terminal = { close, question: (_message: string, options: { signal: AbortSignal }) =>
      new Promise<string>((_resolve, reject) => options.signal.addEventListener("abort", () =>
        reject(new Error("prompt aborted")), { once: true })) };
    try {
      await expect(withOwnedReceiptPrompt(runtime, terminal, "job-123", finalize, 30))
        .rejects.toThrow("timed out");
      expect(close).toHaveBeenCalledOnce();
      expect(finalize).not.toHaveBeenCalled();
      const queueRuntime = await launchBrowser({ profileDirectory, headless: true });
      await queueRuntime.close();
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
