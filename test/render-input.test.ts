import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { applicationPackageSchema } from "../src/application/runner.js";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { renderInputSchema } from "../src/resume/render-input.js";

const example = JSON.parse(await readFile("examples/render-input.example.json", "utf8"));

describe("single-application browser runtime selection", () => {
  it("preserves the BrowserOS example by default", () => {
    expect(renderInputSchema.parse(example).browserRuntime).toBe("browseros");
  });

  it("accepts an owned render input without a connector endpoint", () => {
    const { browserEndpoint: _endpoint, ...owned } = example;
    expect(renderInputSchema.parse({ ...owned, browserRuntime: "owned" }).browserEndpoint).toBeUndefined();
  });

  it("rejects mismatched browser settings in render inputs and packages", () => {
    expect(renderInputSchema.safeParse({ ...example, browserRuntime: "owned" }).success).toBe(false);
    const { browserEndpoint: _endpoint, ...withoutEndpoint } = example;
    expect(renderInputSchema.safeParse(withoutEndpoint).success).toBe(false);
    const packageFields = { version: 1, job: example.job, source: example.source,
      candidate: example.candidate, handoff: createApplicationHandoff(example.job, true),
      resumeSource: { latex: "source", fingerprint: "a".repeat(64), renderToken: "b".repeat(64),
        claimIds: ["example-claim"] }, resumePdfPath: "/private/resume.pdf" };
    expect(applicationPackageSchema.safeParse({ ...packageFields, browserRuntime: "owned" }).success)
      .toBe(true);
    expect(applicationPackageSchema.safeParse({ ...packageFields, browserRuntime: "browseros",
      browserEndpoint: example.browserEndpoint }).success).toBe(true);
    expect(applicationPackageSchema.safeParse({ ...packageFields, browserRuntime: "owned",
      browserEndpoint: example.browserEndpoint }).success).toBe(false);
    expect(applicationPackageSchema.safeParse({ ...packageFields, browserRuntime: "browseros" }).success)
      .toBe(false);
  });
});
