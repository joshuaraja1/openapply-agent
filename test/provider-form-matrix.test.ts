import { describe, expect, it, vi } from "vitest";
import { fillApplicationForm, planApplicationForm } from "../src/application/form-mapper.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import type { BrowserControl, BrowserSnapshot } from "../src/browser/actions.js";
import type { Provider } from "../src/types.js";

// These are contract cases, not 100 employer submissions. The browser suite
// separately exercises navigation, upload, and job-bound confirmation.
const candidate = candidateProfileSchema.parse({
  version: 1,
  identity: { fullName: "Test Candidate", email: "test@example.com", phone: "555-0100",
    location: "Dallas, TX", linkedin: "https://linkedin.com/in/test",
    github: "https://github.com/test", portfolio: "https://example.com" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});

function input(ref: string, name: string, type = "text", required = true): BrowserControl {
  return { ref, tag: "input", role: null, name, type, value: null, required, options: [] };
}

function select(ref: string, name: string): BrowserControl {
  return { ref, tag: "select", role: null, name, type: null, value: null,
    required: true, options: ["Select", "Yes", "No"] };
}

const nameLayouts = [
  ["Name"], ["Full name"], ["First name", "Last name"],
  ["Given name", "Family name"], ["provider-name"],
] as const;
const extras = ["minimal", "contact", "links", "authorization"] as const;
const hazards = ["clean", "unknown-required", "duplicate-email", "captcha", "missing-upload"] as const;

for (const provider of ["greenhouse", "ashby"] as const) {
  const providerNameLayouts = provider === "greenhouse"
    ? [...nameLayouts.slice(0, 4), ["First name", "Surname"] as const] : nameLayouts;
  describe(`${provider} 100-case form mapping contract`, () => {
    for (const [layoutIndex, names] of providerNameLayouts.entries()) {
      for (const extra of extras) {
        for (const hazard of hazards) {
          const label = `${layoutIndex}/${extra}/${hazard}`;
          it(label, async () => {
            const controls: BrowserControl[] = [];
            const add = (name: string, type = "text", required = true) => {
              controls.push(input(String(controls.length + 1), name, type, required));
            };
            for (const name of names) add(name === "provider-name"
              ? provider === "ashby" ? "Your name" : "Full name" : name);
            add("Email", "email");
            if (extra === "contact") {
              add(provider === "ashby" ? "Your phone number" : "Phone");
              add(provider === "ashby" ? "Your LinkedIn profile" : "LinkedIn Profile URL");
            }
            if (extra === "links") {
              add(provider === "ashby" ? "Your GitHub profile" : "GitHub Profile URL");
              add(provider === "ashby" ? "Personal website URL" : "Website URL");
            }
            if (extra === "authorization") {
              controls.push(select(String(controls.length + 1),
                "Are you legally authorized to work in the United States?"));
              controls.push(select(String(controls.length + 1),
                "Will you now or in the future require visa sponsorship to work in the United States?"));
            }
            if (hazard !== "missing-upload") add("Resume", "file");
            if (hazard === "unknown-required") add("Export control eligibility");
            if (hazard === "duplicate-email") add("Email", "email");
            const snapshot: BrowserSnapshot = { url: "https://jobs.example.com/apply/123456",
              title: "Synthetic application", controls,
              visibleText: hazard === "captcha" ? "Verify you are human with CAPTCHA" : "Apply" };
            const plan = planApplicationForm(snapshot, candidate, "/tmp/verified-resume.pdf", { provider });
            const browser = { act: vi.fn().mockResolvedValue(snapshot) };
            const result = await fillApplicationForm(browser as never, snapshot, candidate,
              "/tmp/verified-resume.pdf", { provider });

            if (hazard === "clean") {
              expect(plan.blockers).toEqual([]);
              expect(plan.actions).toContainEqual(expect.objectContaining({
                name: "Resume", action: "upload", value: "/tmp/verified-resume.pdf",
              }));
              expect(plan.actions).toContainEqual(expect.objectContaining({
                name: "Email", action: "fill", value: "test@example.com",
              }));
              if (extra === "contact") expect(plan.actions.map(({ value }) => value))
                .toEqual(expect.arrayContaining(["555-0100", "https://linkedin.com/in/test"]));
              if (extra === "links") expect(plan.actions.map(({ value }) => value))
                .toEqual(expect.arrayContaining(["https://github.com/test", "https://example.com"]));
              if (extra === "authorization") expect(plan.actions.filter(({ action }) => action === "select")
                .map(({ value }) => value)).toEqual(["Yes", "No"]);
              expect(result.blockers).toEqual([]);
            } else {
              expect(plan.blockers.length).toBeGreaterThan(0);
              expect(result.blockers).toEqual(plan.blockers);
              expect(browser.act).not.toHaveBeenCalled();
              if (hazard === "unknown-required") expect(plan.blockers)
                .toContain("Required field needs an answer: Export control eligibility");
              if (hazard === "duplicate-email") expect(plan.blockers)
                .toContain("Required field needs an answer: Email");
              if (hazard === "captcha") expect(plan.blockers)
                .toContain("Human verification is present on the application page");
              if (hazard === "missing-upload") expect(plan.blockers.some((blocker) =>
                blocker.includes("Resume upload control was not found"))).toBe(true);
            }
          });
        }
      }
    }
  });
}
