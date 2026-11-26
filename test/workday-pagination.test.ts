import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSource } from "../src/config.js";
import { fetchSource } from "../src/sources/fetch.js";

const source: JobSource = { provider: "workday", company: "Example", enabled: true,
  allowedApplicationHosts: [], host: "example.myworkdayjobs.com", tenant: "example",
  site: "External", searchText: "engineer" };
const posting = (id: string) => ({ title: `Engineer ${id}`,
  externalPath: `/job/Remote/Engineer_${id}`, postedOn: "Posted 2 Days Ago",
  bulletFields: ["TypeScript"] });
const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json" },
});

afterEach(() => vi.unstubAllGlobals());

describe("Workday job search pagination", () => {
  it("includes postings beyond the first response", async () => {
    const offsets: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)) as { offset: number; limit: number };
      offsets.push(body.offset);
      return json({ total: 3, jobPostings: body.offset === 0
        ? [posting("1"), posting("2")] : [posting("3")] });
    }));
    const jobs = await fetchSource(source, new Date("2026-11-25T16:00:00Z"), 5);
    expect(jobs.map((job) => job.id)).toEqual([
      "workday:example:External:1", "workday:example:External:2", "workday:example:External:3",
    ]);
    expect(offsets).toEqual([0, 2]);
  });

  it("fails the source if pagination repeats a posting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ total: 3, jobPostings: [posting("1")] })));
    await expect(fetchSource(source)).rejects.toThrow("repeated a posting across pages");
  });
});
