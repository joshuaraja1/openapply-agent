import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { uncertainReviewItems } from "../src/application/uncertain-review.js";
import { startUncertainReviewUi } from "../src/application/uncertain-review-ui.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";
import type { readApplicationPackage } from "../src/application/package-file.js";

const uncertain: ApplicationCheckpoint = {
  jobId: "job:one", stage: "submission-uncertain",
  officialUrl: "https://employer.example/jobs/one",
  blocker: "Final click was interrupted; verify employer confirmation",
  packagePath: "C:\\Users\\Candidate\\.openapply-agent\\application-one.json",
  browserPageUrl: "https://employer.example/apply/one",
  updatedAt: "2026-11-26T10:00:00.000Z",
};

describe("uncertain submission review", () => {
  it("lists only uncertain records, verifies package identity, and preserves exact blocker", async () => {
    const pkg = { job: { id: "job:one", applicationUrl: uncertain.officialUrl,
      company: "Example Co", title: "Software Engineer" } } as
      Awaited<ReturnType<typeof readApplicationPackage>>;
    const readPackage = vi.fn(async () => pkg);
    const records = [{ id: "job:one", state: uncertain },
      { id: "job:two", state: { ...uncertain, jobId: "job:two", stage: "submitted" as const } },
      { id: "deleted" }];
    expect(await uncertainReviewItems(records, readPackage)).toEqual([{
      jobId: "job:one", jobLabel: "Example Co — Software Engineer",
      officialUrl: uncertain.officialUrl, blocker: uncertain.blocker,
      packagePath: uncertain.packagePath, browserPageUrl: uncertain.browserPageUrl,
      updatedAt: uncertain.updatedAt,
    }]);
    expect(readPackage).toHaveBeenCalledWith(uncertain.packagePath);
    expect((await uncertainReviewItems(records, async () => ({ ...pkg,
      job: { ...pkg.job, id: "other" } }))).at(0)?.jobLabel).toBe("job:one");
    expect((await uncertainReviewItems(records, async () => { throw new Error("missing"); }))
      .at(0)?.jobLabel).toBe("job:one");
    await expect(uncertainReviewItems([{ id: "wrong", state: uncertain }]))
      .rejects.toThrow(/mismatched identity/);
  });

  it("serves a token-protected, read-only local screen with no private data in HTML", async () => {
    const item = (await uncertainReviewItems([{ id: uncertain.jobId, state: uncertain }],
      async () => { throw new Error("missing"); }))[0]!;
    const loadItems = vi.fn(async () => [item]);
    const ui = await startUncertainReviewUi({ loadItems });
    try {
      const url = new URL(ui.url), token = url.searchParams.get("token")!;
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).not.toContain(uncertain.blocker!);
      expect(html).not.toContain(uncertain.packagePath!);
      expect(html).not.toContain(uncertain.jobId);
      expect(html).not.toContain("/api/resume");
      const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
      expect(() => new Script(script!)).not.toThrow();
      expect((await fetch(`${url.origin}/api/uncertain`)).status).toBe(403);
      expect((await fetch(`${url.origin}/api/uncertain`, {
        method: "POST", headers: { "x-openapply-token": token },
      })).status).toBe(403);
      const result = await fetch(`${url.origin}/api/uncertain`, {
        headers: { "x-openapply-token": token },
      });
      expect(await result.json()).toEqual({ items: [item] });
      expect(loadItems).toHaveBeenCalledOnce();
    } finally { await ui.close(); }
  });
});
