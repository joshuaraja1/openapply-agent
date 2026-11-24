import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSecretInput } from "../src/auth/secret-input.js";

describe("private secret input", () => {
  it("accepts an exact piped password without trimming spaces", async () => {
    expect(await readSecretInput(Readable.from(["  leading and trailing  "])))
      .toBe("  leading and trailing  ");
  });

  it("rejects empty, line-broken, and oversized input", async () => {
    for (const value of ["", "password\n", "pass\0word", "x".repeat(4097)]) {
      await expect(readSecretInput(Readable.from([value]))).rejects.toThrow();
    }
  });
});
