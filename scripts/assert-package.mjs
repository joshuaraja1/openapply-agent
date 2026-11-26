import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0].files)) {
  throw new Error("npm did not produce a package manifest");
}
const files = manifest[0].files.map((entry) => entry.path);
for (const required of ["dist/src/product-cli.js", "templates/user/01-candidate-profile.md",
  "templates/resume/main.tex", "README.md"]) {
  if (!files.includes(required)) throw new Error(`Portable package is missing ${required}`);
}
const forbidden = files.filter((path) => /^(?:data|output|storage|test|coverage)\//.test(path)
  || /(?:^|\/)\.env(?:\.|$)|\.(?:pdf|zip)$/i.test(path));
if (forbidden.length) throw new Error(`Private or generated files entered the package: ${forbidden.join(", ")}`);
console.log(`Portable package contains ${files.length} public files`);
