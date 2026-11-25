import { createPrivateOutput } from "../storage/private-output.js";
import { readPrivateFile } from "../storage/private-path.js";
import { applicationPackageSchema, type ApplicationPackage } from "./runner.js";

/** The application package contains candidate identity and must stay private on every OS. */
export async function readApplicationPackage(path: string): Promise<ApplicationPackage> {
  const content = await readPrivateFile(path);
  try {
    return applicationPackageSchema.parse(JSON.parse(content));
  } catch {
    throw new Error("Private application package is invalid");
  }
}

export async function writeApplicationPackage(path: string, input: ApplicationPackage): Promise<void> {
  const pkg = applicationPackageSchema.parse(input);
  await createPrivateOutput(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
