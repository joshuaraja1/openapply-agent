import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function assertPackageManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0].files)) {
    throw new Error("npm did not produce a package manifest");
  }
  const files = manifest[0].files.map((entry) => entry.path);
  for (const required of ["dist/src/product-cli.js", "templates/user/01-candidate-profile.md",
    "templates/resume/main.tex", "README.md", "LICENSE"]) {
    if (!files.includes(required)) throw new Error(`Portable package is missing ${required}`);
  }
  const allowed = /^(?:dist\/src|templates|examples|docs)\/|^(?:README\.md|LICENSE|package\.json)$/;
  const forbidden = files.filter((path) => !allowed.test(path)
    || /(?:^|\/)\.env(?:\.|$)|\.(?:pdf|zip|pem|key|p12|pfx|sqlite|db)$/i.test(path));
  if (forbidden.length) throw new Error(`Private or generated files entered the package: ${forbidden.join(", ")}`);
  return files.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
  console.log(`Portable package contains ${assertPackageManifest(manifest)} public files`);
}
