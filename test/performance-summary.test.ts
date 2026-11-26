import { describe, expect, it } from "vitest";
import { summarizeTimings } from "../src/performance/summary.js";

describe("performance summary", () => {
  it("reports median, nearest-rank p95, and failure counts", () => {
    const samples = Array.from({ length: 30 }, (_, index) => index + 1).reverse();
    expect(summarizeTimings(samples, 2)).toEqual({
      count: 30, failures: 2, medianMs: 15.5, p95Ms: 29,
    });
    expect(samples[0]).toBe(30);
  });

  it("records empty samples without inventing a latency", () => {
    expect(summarizeTimings([], 3)).toEqual({ count: 0, failures: 3,
      medianMs: null, p95Ms: null });
    expect(() => summarizeTimings([-1])).toThrow("nonnegative");
    expect(() => summarizeTimings([Number.NaN])).toThrow("nonnegative");
    expect(() => summarizeTimings([1], -1)).toThrow("nonnegative");
  });
});
