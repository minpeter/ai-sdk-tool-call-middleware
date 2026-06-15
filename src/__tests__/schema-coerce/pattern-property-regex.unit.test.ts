import { describe, expect, it } from "vitest";
import { compileSafePatternPropertyRegex } from "../../schema-coerce";

describe("compileSafePatternPropertyRegex", () => {
  it("accepts non-capturing group prefixes as safe syntax", () => {
    const regex = compileSafePatternPropertyRegex("^(?:x-)+$");
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex?.test("x-")).toBe(true);
  });
});
