import { describe, expect, it } from "vitest";
import { GreenhouseReceiptVerifier } from "../src/cloud/hosted-greenhouse-application.js";
import type { VerifiedReceipt } from "../src/cloud/queued-run.js";

const job = { provider: "greenhouse", employerId: "acme", requisitionId: "123456" };
const verifier = new GreenhouseReceiptVerifier();
function receipt(url: string, confirmation: string): VerifiedReceipt {
  return { job, evidence: new TextEncoder().encode(JSON.stringify({
    version: 1, job, url, confirmation,
  })) };
}

describe("Greenhouse exact-job receipt", () => {
  it("accepts an exact requisition confirmation on the official job URL", async () => {
    expect(await verifier.verify(receipt("https://boards.greenhouse.io/acme/jobs/123456",
      "Application received for requisition 123456"), job)).toBe(true);
  });

  it("rejects generic success text, other requisitions, and unrelated hosts", async () => {
    for (const [url, text] of [
      ["https://boards.greenhouse.io/acme/jobs/123456", "Thank you for applying"],
      ["https://boards.greenhouse.io/acme/jobs/999999", "Application received for requisition 123456"],
      ["https://example.invalid/acme/jobs/123456", "Application received for requisition 123456"],
      ["https://boards.greenhouse.io/acme/jobs/123456", "Application received for requisition 999999"],
    ]) expect(await verifier.verify(receipt(url!, text!), job)).toBe(false);
  });
});
