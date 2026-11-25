import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSetupUi } from "../src/setup/ui.js";

describe("local first-run setup", () => {
  it("serves private templates, saves with compare-and-swap, and rejects cross-origin writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-setup-ui-"));
    const ui = await startSetupUi({ destination: join(root, "onboarding"), repositoryRoot: process.cwd() });
    try {
      const url = new URL(ui.url);
      const token = url.searchParams.get("token")!;
      const origin = url.origin;
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect((await fetch(`${origin}/api/templates`)).status).toBe(403);
      const listing = await fetch(`${origin}/api/templates`, { headers: { "x-openapply-token": token } });
      const files = (await listing.json()) as { files: { name: string; content: string; sha256: string }[] };
      expect(files.files).toHaveLength(8);
      const first = files.files[0]!;
      const target = `${origin}/api/template/${first.name}`;
      const update = { content: `${first.content}\nPrivate answer`, expectedSha256: first.sha256 };
      const headers = { "content-type": "application/json", "x-openapply-token": token,
        origin };
      expect((await fetch(target, { method: "PUT", headers: { ...headers, origin: "https://evil.example" },
        body: JSON.stringify(update) })).status).toBe(403);
      expect((await fetch(`${origin}/api/template/../unrelated`, { method: "PUT", headers,
        body: JSON.stringify(update) })).status).toBe(404);
      expect((await fetch(target, { method: "PUT", headers, body: JSON.stringify(update) })).status).toBe(200);
      expect((await fetch(target, { method: "PUT", headers, body: JSON.stringify(update) })).status).toBe(409);
      const path = join(root, "onboarding", first.name);
      expect(await readFile(path, "utf8")).toBe(update.content);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0);
    } finally {
      await ui.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
