import type { BrowserRuntime } from "../browser/runtime.js";
import { isOwnedReceiptAttested } from "./owned-confirm.js";

export interface ReceiptPrompt {
  question(message: string, options: { signal: AbortSignal }): Promise<string>;
  close(): void;
}

/** Bound the candidate wait so the owned profile cannot be reserved indefinitely. */
export async function withOwnedReceiptPrompt<T>(
  runtime: Pick<BrowserRuntime, "close">, terminal: ReceiptPrompt,
  jobId: string, finalize: () => Promise<T>, timeoutMs = 120_000,
): Promise<T> {
  const abort = new AbortController();
  let reason = "timed out";
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const interrupt = () => { reason = "cancelled"; abort.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const answer = await terminal.question(
      `When the receipt is visible in that browser, type the exact job ID ${jobId}: `,
      { signal: abort.signal });
    const accountAnswer = await terminal.question(
      "Did you submit this application using your own signed-in employer account? Type YES or NO: ",
      { signal: abort.signal });
    if (!isOwnedReceiptAttested(jobId, answer, accountAnswer)) {
      throw new Error("Candidate account and submission attestation did not match");
    }
    if (abort.signal.aborted) throw new Error(`Owned receipt prompt ${reason}`);
    clearTimeout(timer);
    return await finalize();
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`Owned receipt prompt ${reason}; rerun verification when ready`);
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    terminal.close();
    await runtime.close();
  }
}
