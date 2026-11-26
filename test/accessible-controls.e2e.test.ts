import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser/actions.js";
import { planApplicationForm } from "../src/application/form-mapper.js";
import type { CandidateProfile } from "../src/candidate/schema.js";

const html = `<!doctype html><title>Apply</title><x-form></x-form>
<script>
  const root = document.querySelector('x-form').attachShadow({ mode: 'open' });
  root.innerHTML = '<label for="email">Email</label><input id="email" required>' +
    '<span id="location-label">Work location</span>' +
    '<button type="button" role="combobox" aria-labelledby="location-label" aria-controls="locations" aria-expanded="false">Choose</button>' +
    '<div id="locations" role="listbox" hidden><div role="option">Remote</div><div role="option">Dallas</div></div>' +
    '<div role="listbox"><div role="option" id="unrelated">Remote</div></div>' +
    '<form><button role="combobox" aria-label="Unsafe role">Choose</button>' +
    '<input type="submit" role="combobox" aria-label="Unsafe input"></form>' +
    '<button id="next" type="button">Next</button>';
  const combo = root.querySelector('[role=combobox]');
  const list = root.querySelector('#locations');
  root.querySelector('#unrelated').addEventListener('click', () => { window.unrelatedClicked = true; });
  combo.addEventListener('click', () => {
    setTimeout(() => {
      list.hidden = false;
      combo.setAttribute('aria-expanded', 'true');
      if (window.duplicateOptions) {
        const duplicate = document.createElement('div');
        duplicate.setAttribute('role', 'option');
        duplicate.textContent = 'Remote';
        list.append(duplicate);
      }
    }, 50);
  });
  for (const option of list.querySelectorAll('[role=option]')) {
    option.addEventListener('click', () => {
      window.optionClicks = (window.optionClicks || 0) + 1;
      if (window.asyncCombo) setTimeout(() => { combo.textContent = option.textContent; }, 100);
      else combo.textContent = option.textContent;
      combo.setAttribute('aria-expanded', 'false');
      list.hidden = true;
      if (window.rerenderCombo) combo.replaceWith(combo.cloneNode(true));
    });
  }
  root.querySelector('#next').addEventListener('click', () => {
    root.innerHTML = '<label for="phone">Phone</label><input id="phone" required>' +
      '<button type="submit">Submit application</button>';
  });
</script>`;

describe("owned browser accessible controls", () => {
  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "never selects a same-ID option in another shadow root", async () => {
      const directory = await mkdtemp(join(tmpdir(), "openapply-controls-scope-"));
      const context = await chromium.launchPersistentContext(join(directory, "profile"), { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) => route.fulfill({ contentType: "text/html", body: `
          <!doctype html><title>Apply</title><x-target></x-target><x-decoy></x-decoy><script>
          document.querySelector('x-target').attachShadow({mode:'open'}).innerHTML =
            '<button type="button" role="combobox" aria-label="Work location" aria-controls="locations">Choose</button>';
          document.querySelector('x-decoy').attachShadow({mode:'open'}).innerHTML =
            '<div id="locations" role="listbox"><div role="option">Remote</div></div>';
          document.querySelector('x-decoy').shadowRoot.querySelector('[role=option]')
            .addEventListener('click', () => { window.decoyClicked = true; });</script>` }));
        const browser = new AgentBrowser(context, new Set(["jobs.example.com"]));
        const first = await browser.navigate("https://jobs.example.com/apply");
        const combo = first.controls.find((control) => control.name === "Work location")!;
        await expect(browser.act(combo.ref, "select", "Remote"))
          .rejects.toThrow("owned listbox was not visible");
        const page = context.pages().find((candidate) => candidate.url() === "https://jobs.example.com/apply")!;
        expect(await page.evaluate(() => (window as Window & { decoyClicked?: boolean }).decoyClicked))
          .toBeUndefined();
      } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000,
  );
  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "reports an uncertain selection if a form replaces its combobox", async () => {
      const directory = await mkdtemp(join(tmpdir(), "openapply-controls-rerender-"));
      const context = await chromium.launchPersistentContext(join(directory, "profile"), { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) =>
          route.fulfill({ contentType: "text/html", body: html }));
        const browser = new AgentBrowser(context, new Set(["jobs.example.com"]));
        const first = await browser.navigate("https://jobs.example.com/apply");
        const page = context.pages().find((candidate) => candidate.url() === "https://jobs.example.com/apply")!;
        await page.evaluate(() => {
          (window as Window & { rerenderCombo?: boolean }).rerenderCombo = true;
          const root = document.querySelector('x-form')!.shadowRoot!;
          const unrelated = document.createElement('button');
          unrelated.setAttribute('role', 'combobox');
          unrelated.setAttribute('aria-controls', 'locations');
          unrelated.textContent = 'Remote';
          root.append(unrelated);
        });
        const combo = first.controls.find((control) => control.name === "Work location")!;
        await expect(browser.act(combo.ref, "select", "Remote"))
          .rejects.toThrow("Selection outcome uncertain; take a new snapshot");
        expect(await page.evaluate(() => (window as Window & { optionClicks?: number }).optionClicks)).toBe(1);
      } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000,
  );
  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "waits for an asynchronous value update without clicking twice", async () => {
      const directory = await mkdtemp(join(tmpdir(), "openapply-controls-async-"));
      const context = await chromium.launchPersistentContext(join(directory, "profile"), { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) =>
          route.fulfill({ contentType: "text/html", body: html }));
        const browser = new AgentBrowser(context, new Set(["jobs.example.com"]));
        const first = await browser.navigate("https://jobs.example.com/apply");
        const page = context.pages().find((candidate) => candidate.url() === "https://jobs.example.com/apply")!;
        await page.evaluate(() => { (window as Window & { asyncCombo?: boolean }).asyncCombo = true; });
        const combo = first.controls.find((control) => control.name === "Work location")!;
        const selected = await browser.act(combo.ref, "select", "Remote");
        expect(selected.controls.find((control) => control.name === "Work location")?.value).toBe("Remote");
        expect(await page.evaluate(() => (window as Window & { optionClicks?: number }).optionClicks)).toBe(1);
      } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000,
  );
  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "includes open shadow challenge text and rejects an implicit submit button", async () => {
      const directory = await mkdtemp(join(tmpdir(), "openapply-controls-safety-"));
      const context = await chromium.launchPersistentContext(join(directory, "profile"), { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) => route.fulfill({ contentType: "text/html", body: `
          <!doctype html><title>Apply</title><x-challenge></x-challenge><form id="application">
          <button>Continue</button></form><script>
          document.querySelector('x-challenge').attachShadow({mode:'open'}).innerHTML =
            '<p>Verify you are human</p><p>By continuing you agree to the terms</p>';
          document.querySelector('#application').addEventListener('submit', (event) => {
            event.preventDefault(); window.submitted = true;
          });</script>` }));
        const browser = new AgentBrowser(context, new Set(["jobs.example.com"]));
        const snapshot = await browser.navigate("https://jobs.example.com/apply");
        expect(snapshot.visibleText).toContain("Verify you are human");
        expect(snapshot.visibleText).toContain("agree to the terms");
        expect(planApplicationForm(snapshot, {} as CandidateProfile, "resume.pdf", { allowMissingResume: true }).blockers)
          .toContain("Human verification is present on the application page");
        const continueButton = snapshot.controls.find((control) => control.name === "Continue")!;
        await expect(browser.act(continueButton.ref, "click")).rejects.toThrow("Submission requires");
        const applicationPage = context.pages().find((page) => page.url() === "https://jobs.example.com/apply")!;
        expect(await applicationPage.evaluate(() => (window as Window & { submitted?: boolean }).submitted))
          .toBeUndefined();
      } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000,
  );
  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")(
    "fills open shadow fields, selects an exact custom option, and re-snapshots each step", async () => {
      const directory = await mkdtemp(join(tmpdir(), "openapply-controls-"));
      const context = await chromium.launchPersistentContext(join(directory, "profile"), { headless: true });
      try {
        await context.route("https://jobs.example.com/**", (route) =>
          route.fulfill({ contentType: "text/html", body: html }));
        const browser = new AgentBrowser(context, new Set(["jobs.example.com"]));
        const first = await browser.navigate("https://jobs.example.com/apply");
        const email = first.controls.find((control) => control.name === "Email");
        const combo = first.controls.find((control) => control.role === "combobox");
        expect(email?.tag).toBe("input");
        expect(combo).toMatchObject({ name: "Work location", tag: "button" });

        const afterEmail = await browser.act(email!.ref, "fill", "candidate@example.com");
        await expect(browser.act(combo!.ref, "select", "Remote")).rejects.toThrow("Stale");
        const currentCombo = afterEmail.controls.find((control) => control.role === "combobox")!;
        const afterSelect = await browser.act(currentCombo.ref, "select", "Remote");
        expect(afterSelect.controls.find((control) => control.role === "combobox")?.value).toBe("Remote");
        const applicationPage = context.pages().find((page) => page.url() === "https://jobs.example.com/apply")!;
        expect(await applicationPage.evaluate(() => (window as Window & { unrelatedClicked?: boolean }).unrelatedClicked))
          .toBeUndefined();
        const unsafe = afterSelect.controls.find((control) => control.name === "Unsafe role")!;
        await expect(browser.act(unsafe.ref, "select", "Remote"))
          .rejects.toThrow("Submission requires");
        const beforeUnsafeInput = await browser.snapshot();
        const unsafeInput = beforeUnsafeInput.controls.find((control) => control.name === "Unsafe input")!;
        await expect(browser.act(unsafeInput.ref, "select", "Remote"))
          .rejects.toThrow("Submission requires");
        await applicationPage.evaluate(() => { (window as Window & { duplicateOptions?: boolean }).duplicateOptions = true; });
        const beforeAmbiguous = await browser.snapshot();
        const ambiguous = beforeAmbiguous.controls.find((control) => control.name === "Work location")!;
        await expect(browser.act(ambiguous.ref, "select", "Remote"))
          .rejects.toThrow("ambiguous");
        const afterAmbiguous = await browser.snapshot();
        const next = afterAmbiguous.controls.find((control) => control.name === "Next")!;
        const second = await browser.act(next.ref, "click");
        expect(second.controls.some((control) => control.name === "Phone")).toBe(true);
        await expect(browser.act(next.ref, "click")).rejects.toThrow("Stale");
        const submit = second.controls.find((control) => control.type === "submit")!;
        await expect(browser.act(submit.ref, "click")).rejects.toThrow("Submission requires");
      } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000,
  );
});
