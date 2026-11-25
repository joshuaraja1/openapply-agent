import { describe, expect, it } from "vitest";
import { extractOfficialPostingLinks } from "../src/browser/official-links.js";

describe("official links in board pages", () => {
  it("keeps only direct ATS posting links and removes tracking", () => {
    expect(extractOfficialPostingLinks(`
      [Apply](https://job-boards.greenhouse.io/acme/jobs/1234?utm_source=board)
      https://job-boards.greenhouse.io/acme/jobs/1234
      https://job-boards.greenhouse.io.evil.test/acme/jobs/1234
      https://www.linkedin.com/jobs/view/42/
    `)).toEqual(["https://job-boards.greenhouse.io/acme/jobs/1234"]);
  });
});
