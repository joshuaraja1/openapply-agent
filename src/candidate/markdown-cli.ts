import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { compileCandidateMarkdown, compileSearchMarkdown } from "./markdown.js";
import { createPrivateOutput } from "../storage/private-output.js";
import { assertPrivateFile, ensurePrivateDirectory } from "../storage/private-path.js";

const variables = ["OPENAPPLY_PROFILE_MD", "OPENAPPLY_WORK_MD", "OPENAPPLY_SEARCH_MD",
  "OPENAPPLY_PROFILE_OUTPUT", "OPENAPPLY_PREFERENCES_OUTPUT"] as const;
const paths = variables.map((name) => {
  const path = process.env[name];
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute private path`);
  return path;
});
const [profileMd, workMd, searchMd, profileOutput, preferencesOutput] = paths as [string, string, string, string, string];
if (resolve(profileOutput) === resolve(preferencesOutput)) throw new Error("Candidate and preference outputs need separate files");
for (const input of [profileMd, workMd, searchMd]) {
  await assertPrivateFile(input);
}
const [profile, work, search] = await Promise.all([
  readFile(profileMd, "utf8"), readFile(workMd, "utf8"), readFile(searchMd, "utf8"),
]);
const candidate = compileCandidateMarkdown(profile, work);
const preferences = compileSearchMarkdown(search);
for (const output of [profileOutput, preferencesOutput]) {
  await ensurePrivateDirectory(dirname(output));
}
await createPrivateOutput(profileOutput, `${JSON.stringify(candidate, null, 2)}\n`);
await createPrivateOutput(preferencesOutput, `${JSON.stringify(preferences, null, 2)}\n`);
console.log("Compiled private candidate profile and search preferences");
