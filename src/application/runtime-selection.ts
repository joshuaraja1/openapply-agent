import type { ApplicationPackage } from "./runner.js";

/** A saved package determines the runtime; environment cannot choose a new profile. */
export function savedBrowserEndpoint(
  pkg: Pick<ApplicationPackage, "browserRuntime" | "browserEndpoint">, override?: string,
): string | undefined {
  if (pkg.browserRuntime === "owned" && (pkg.browserEndpoint || override)) {
    throw new Error("Owned application package cannot use a BrowserOS endpoint");
  }
  if (override && override !== pkg.browserEndpoint) {
    throw new Error("BrowserOS endpoint differs from the saved application package");
  }
  if (pkg.browserRuntime === "browseros" && !pkg.browserEndpoint) {
    throw new Error("BrowserOS application package requires its saved endpoint");
  }
  return pkg.browserEndpoint;
}
