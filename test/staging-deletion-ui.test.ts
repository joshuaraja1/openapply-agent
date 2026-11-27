import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Staging site is a standalone JavaScript module.
import { attachCandidateDeletion } from "../cloud/staging-login/deletion.js";

function node() {
  const listeners = new Map<string, () => void>();
  return { hidden: false, disabled: false, value: "", textContent: "",
    addEventListener(event: string, callback: () => void) { listeners.set(event, callback); },
    emit(event: string) { listeners.get(event)?.(); } };
}

afterEach(() => vi.unstubAllGlobals());

describe("signed-in staging deletion UI", () => {
  it("keeps onboarding visible when status is none; hides it after an explicit request", async () => {
    const elements = new Map([
      ["#candidate-deletion", node()], ["#deletion-status", node()],
      ["#deletion-confirm", node()], ["#deletion-request", node()],
      ["#deletion-refresh", node()], ["#candidate-setup", node()],
    ]);
    vi.stubGlobal("document", { querySelector: (selector: string) => elements.get(selector) });
    const fetch = vi.fn(async (path: string) => new Response(JSON.stringify({
      state: path.endsWith("deletion-status") ? "none" : "complete" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    attachCandidateDeletion({ getIdToken: () => "a.b.c" });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(elements.get("#candidate-setup")?.hidden).toBe(false);
    expect(elements.get("#deletion-status")?.textContent).toBe("No deletion request is pending.");
    const confirm = elements.get("#deletion-confirm")!;
    const button = elements.get("#deletion-request")!;
    confirm.value = "DELETE";
    confirm.emit("input");
    expect(button.disabled).toBe(false);
    button.emit("click");
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(elements.get("#candidate-setup")?.hidden).toBe(true);
    expect(elements.get("#deletion-status")?.textContent).toContain("Final account deletion requires");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
