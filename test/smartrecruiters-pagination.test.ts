import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSource } from "../src/config.js";
import { fetchSource } from "../src/sources/fetch.js";

const source: JobSource = { provider: "smartrecruiters", company: "Example",
  companyIdentifier: "Example", enabled: true, allowedApplicationHosts: [] };
const posting = (id: string) => ({ id, name: `Engineer ${id}`,
  jobAd: { sections: { description: { text: `<p>Build TypeScript service ${id}</p>` } } } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});

afterEach(() => vi.unstubAllGlobals());

describe("SmartRecruiters posting pagination", () => {
  it("fetches later pages and job details before returning active postings", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.pathname.endsWith("/postings")) {
        const offset = Number(url.searchParams.get("offset"));
        return json({ offset, totalFound: 3,
          content: offset === 0 ? [posting("1"), posting("2")] : [posting("3")] });
      }
      return json(posting(url.pathname.split("/").at(-1)!));
    }));

    const jobs = await fetchSource(source, new Date("2026-01-01T00:00:00Z"), 5);
    expect(jobs.map((job) => job.id)).toEqual([
      "smartrecruiters:Example:1", "smartrecruiters:Example:2", "smartrecruiters:Example:3",
    ]);
    expect(jobs.every((job) => job.descriptionText.includes("TypeScript"))).toBe(true);
    expect(requests.filter((url) => new URL(url).pathname.endsWith("/postings"))
      .map((url) => new URL(url).searchParams.get("offset"))).toEqual(["0", "2"]);
  });

  it("fails the source when a detail request fails, rather than treating it as complete", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) =>
      new URL(String(input)).pathname.endsWith("/postings")
        ? json({ offset: 0, totalFound: 1, content: [posting("1")] })
        : json({ error: "unavailable" }, 503)));
    await expect(fetchSource(source)).rejects.toThrow("detail returned HTTP 503");
  });
});
