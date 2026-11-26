import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackageManifest } from "./assert-package.mjs";

const publicFiles = ["dist/src/product-cli.js", "templates/user/01-candidate-profile.md",
  "templates/resume/main.tex", "README.md", "LICENSE", "package.json", "runtime-package-lock.json"];
const manifest = (files) => [{ files: files.map((path) => ({ path })) }];

test("accepts a portable package with CLI and templates", () => {
  assert.equal(assertPackageManifest(manifest(publicFiles)), publicFiles.length);
});

test("rejects private files and credentials even under public package folders", () => {
  for (const path of ["data/private/profile.json", "docs/.env", "examples/signing.p12",
    "templates/user/candidate.pdf", "dist/src/runtime.sqlite"]) {
    assert.throws(() => assertPackageManifest(manifest([...publicFiles, path])), /Private or generated files/);
  }
});

test("rejects incomplete packages", () => {
  assert.throws(() => assertPackageManifest(manifest(publicFiles.filter((file) => file !== "dist/src/product-cli.js"))),
    /missing dist\/src\/product-cli.js/);
});
