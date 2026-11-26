import { createHash } from "node:crypto";
import type { ApplicationPackage } from "./runner.js";

/** Bind the exact parsed private package used for the final-click claim. */
export function applicationPackageFingerprint(pkg: ApplicationPackage): string {
  return createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
}
