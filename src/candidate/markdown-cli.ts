import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { compileCandidateMarkdown, compileSearchMarkdown } from "./markdown.js";
import { createPrivateOutput } from "../storage/private-output.js";

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
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
    || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Completed Markdown inputs must be private to this user");
  }
}
const [profile, work, search] = await Promise.all([
  readFile(profileMd, "utf8"), readFile(workMd, "utf8"), readFile(searchMd, "utf8"),
]);
const candidate = compileCandidateMarkdown(profile, work);
const preferences = compileSearchMarkdown(search);
for (const output of [profileOutput, preferencesOutput]) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const info = await lstat(dirname(output));
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
    || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Candidate output directories must be private to this user");
  }
}
await createPrivateOutput(profileOutput, `${JSON.stringify(candidate, null, 2)}\n`);
await createPrivateOutput(preferencesOutput, `${JSON.stringify(preferences, null, 2)}\n`);
console.log("Compiled private candidate profile and search preferences");
