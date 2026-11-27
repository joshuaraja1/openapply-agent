import { afterEach, describe, expect, it, vi } from "vitest";
import { deletionHandler } from "../src/hosted/aws-onboarding-lambda.js";
import type { HttpApiEvent } from "../src/hosted/aws-lambda-adapter.js";

afterEach(() => vi.unstubAllEnvs());

describe("dedicated deletion Lambda boundary", () => {
  it("rejects onboarding and plan paths before constructing a runtime", async () => {
    vi.stubEnv("CANDIDATE_DELETION_ENABLED", "true");
    for (const rawPath of ["/api/candidates/onboarding", "/api/candidates/plan"] ) {
      const event = { version: "2.0", rawPath,
        requestContext: { http: { method: "POST" } } } as HttpApiEvent;
      expect((await deletionHandler(event)).statusCode).toBe(404);
    }
  });
});
