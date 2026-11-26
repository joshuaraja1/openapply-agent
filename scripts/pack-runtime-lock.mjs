import { constants, copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve("package-lock.json");
const packed = resolve("runtime-package-lock.json");

export function validateRuntimeLock(pkg, lock) {
  if (lock.lockfileVersion !== 3 || lock.name !== pkg.name || lock.version !== pkg.version
    || JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify(pkg.dependencies)) {
    throw new Error("Runtime lock does not match the package manifest");
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || !entry.resolved) continue;
    if (!entry.resolved.startsWith("https://registry.npmjs.org/")
      || !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? "")) {
      throw new Error(`Runtime dependency has no registry SHA-512 integrity: ${name}`);
    }
  }
}

export function prepareRuntimeLock() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync(source, "utf8"));
  validateRuntimeLock(pkg, lock);
  if (existsSync(packed)) throw new Error("Refusing to replace an existing runtime lock");
  copyFileSync(source, packed, constants.COPYFILE_EXCL);
}

export function removeRuntimeLock() {
  if (!existsSync(packed)) return;
  const original = readFileSync(source);
  const generated = readFileSync(packed);
  if (!original.equals(generated)) throw new Error("Refusing to remove a changed runtime lock");
  unlinkSync(packed);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "prepare") prepareRuntimeLock();
  else if (process.argv[2] === "remove") removeRuntimeLock();
  else throw new Error("Usage: pack-runtime-lock.mjs prepare|remove");
}
