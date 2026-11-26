import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { startHandoffUi } from "../src/application/handoff-ui.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";

const pending: ApplicationCheckpoint = { jobId: "job:123", officialUrl: "https://jobs.example.com/123",
  stage: "waiting-human", blocker: "Provide the exact required field",
  packagePath: "/private/package.json", updatedAt: "2026-11-25T18:00:00.000Z" };

describe("local application handoff", () => {
  it("requires same-origin authorization and resumes only the current paused checkpoint", async () => {
    let state = { ...pending };
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const resume = vi.fn(async () => { await running; state = { ...state, stage: "submitted" }; });
    const ui = await startHandoffUi({ jobId: pending.jobId,
      loadCheckpoint: async () => state, resume });
    try {
      const url = new URL(ui.url), token = url.searchParams.get("token")!;
      const headers = { origin: url.origin, "x-openapply-token": token,
        "content-type": "application/json" };
      const request = { updatedAt: pending.updatedAt, authorizeContinuation: true,
        answers: [{ field: "Required field", value: "Candidate answer" }] };
      const post = (body: unknown, overrides: Record<string, string> = {}) => fetch(`${url.origin}/api/resume`, {
        method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body),
      });
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBeTruthy();
      expect(() => new Script(script!)).not.toThrow();
      expect((await fetch(`${url.origin}/api/handoff`)).status).toBe(403);
      expect((await post(request, { origin: "https://attacker.example" })).status).toBe(403);
      expect((await post({ ...request, authorizeContinuation: false })).status).toBe(400);
      expect((await post({ ...request, updatedAt: "2026-11-24T18:00:00.000Z" })).status).toBe(409);
      expect((await post({ ...request, answers: [request.answers[0], request.answers[0]] })).status).toBe(400);
      expect((await post(request)).status).toBe(202);
      expect((await post(request)).status).toBe(409);
      expect(resume).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledWith(pending, request.answers);
      release();
      await vi.waitFor(async () => {
        const result = await fetch(`${url.origin}/api/handoff`, { headers });
        expect(await result.json()).toMatchObject({ stage: "submitted", busy: false });
      });
      expect((await post(request)).status).toBe(409);
    } finally { release(); await ui.close(); }
  });

  it("shows only the selected job and never includes blocker text in HTML", async () => {
    const ui = await startHandoffUi({ jobId: pending.jobId,
      loadCheckpoint: async () => ({ ...pending, jobId: "another-job" }),
      resume: async () => { throw new Error("Should not run"); } });
    try {
      const url = new URL(ui.url);
      expect((await fetch(ui.url).then((result) => result.text())))
        .not.toContain(pending.blocker!);
      expect((await fetch(`${url.origin}/api/handoff`, {
        headers: { "x-openapply-token": url.searchParams.get("token")! },
      })).status).toBe(404);
    } finally { await ui.close(); }
  });
});
