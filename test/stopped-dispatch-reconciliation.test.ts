import { describe, expect, it, vi } from "vitest";
import { reconcileStoppedDispatch } from "../src/cloud/aws-fargate-launcher-lambda.js";
import type { DynamoApplicationDispatchStore } from "../src/cloud/aws-durable-dispatch.js";
import type { DynamoHostedRunAdmission } from "../src/cloud/aws-enqueue-ports.js";
import type { DurableApplicationJournal } from "../src/cloud/durable-journal.js";
import type { DynamoFargateLaunchStore } from "../src/cloud/fargate-launcher.js";

const candidateId = "19c886c7-3d13-4a16-92fa-7c84d862a9de";
const runId = "9d24cb92-32e1-4e84-9420-ef436f42abf8";
const job = { provider: "Greenhouse", employerId: "acme", requisitionId: "42" };
function harness(status: "not_started" | "needs_reconciliation" | "confirmed", generation = 0) {
  const dispatch = {
    read: vi.fn(async () => ({ state: "launched" as const })),
    markCompleted: vi.fn(async () => {}),
    markNeedsReconciliation: vi.fn(async () => {}),
    markRetryable: vi.fn(async () => {}),
  };
  const admission = { loadIdentity: vi.fn(async () => ({ job })) };
  const journal = { readSubmission: vi.fn(async () => ({ status })) };
  const launch = { read: vi.fn(async () => ({ state: "stopped" as const, generation })) };
  const ports = { dispatch: dispatch as unknown as Pick<DynamoApplicationDispatchStore,
      "read" | "markCompleted" | "markNeedsReconciliation" | "markRetryable">,
    admission: admission as unknown as Pick<DynamoHostedRunAdmission, "loadIdentity">,
    journal: journal as unknown as Pick<DurableApplicationJournal, "readSubmission">,
    launch: launch as unknown as Pick<DynamoFargateLaunchStore, "read"> };
  return { ports, dispatch, admission, journal, launch };
}

describe("stopped exact dispatch reconciliation", () => {
  it("repairs a confirmed journal without requeueing or a second submit", async () => {
    const h = harness("confirmed");
    expect(await reconcileStoppedDispatch(candidateId, runId, h.ports)).toBe("completed");
    expect(h.dispatch.markCompleted).toHaveBeenCalledWith(candidateId, runId);
    expect(h.dispatch.markRetryable).not.toHaveBeenCalled();
    expect(h.dispatch.markNeedsReconciliation).not.toHaveBeenCalled();
  });
  it("requeues only pre-intent crashes with bounded fresh launch generation", async () => {
    const h = harness("not_started", 1);
    expect(await reconcileStoppedDispatch(candidateId, runId, h.ports)).toBe("retryable");
    expect(h.dispatch.markRetryable).toHaveBeenCalledWith(candidateId, runId);
    expect(h.dispatch.markCompleted).not.toHaveBeenCalled();
  });
  it("holds uncertain or exhausted runs for reconciliation", async () => {
    for (const [status, generation] of [
      ["needs_reconciliation", 0], ["not_started", 2],
    ] as const) {
      const h = harness(status, generation);
      expect(await reconcileStoppedDispatch(candidateId, runId, h.ports))
        .toBe("needs_reconciliation");
      expect(h.dispatch.markNeedsReconciliation).toHaveBeenCalledWith(candidateId, runId);
      expect(h.dispatch.markRetryable).not.toHaveBeenCalled();
    }
  });
});
