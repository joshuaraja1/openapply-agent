import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("package version", () => {
  it("uses semantic versioning", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
