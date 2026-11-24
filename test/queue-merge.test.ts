import { describe, expect, it } from "vitest";
import { mergePendingQueue } from "../src/application/queue-merge.js";

describe("pending queue preservation", () => {
  it("keeps unfinished jobs and replaces repeat jobs with fresh postings", () => {
    const previous = [{ job: { id: "one" }, version: 1 }, { job: { id: "two" }, version: 1 }];
    const current = [{ job: { id: "two" }, version: 2 }, { job: { id: "three" }, version: 1 }];
    expect(mergePendingQueue(previous, current).map(({ job, version }) => [job.id, version]))
      .toEqual([["two", 2], ["three", 1], ["one", 1]]);
  });
});
