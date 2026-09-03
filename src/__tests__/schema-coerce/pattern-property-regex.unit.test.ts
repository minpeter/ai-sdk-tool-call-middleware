import { describe, expect, it } from "vitest";
import { compileSafePatternPropertyRegex } from "../../schema-coerce";

describe("compileSafePatternPropertyRegex", () => {
  it("accepts non-capturing group prefixes as safe syntax", () => {
    // Given
    const pattern = "^(?:x-)+$";

    // When
    const regex = compileSafePatternPropertyRegex(pattern);

    // Then
    expect(regex?.test("x-")).toBe(true);
  });

  it.each(["^(a+)+$", "^(a|aa)+$"])(
    "rejects nested or alternating quantified groups for %s",
    (pattern) => {
      // Given / When
      const regex = compileSafePatternPropertyRegex(pattern);

      // Then
      expect(regex).toBeNull();
    }
  );

  it.each(["a+a+", "[ab]+[ab]+", "\\d+\\d+"])(
    "rejects adjacent repeated quantified atoms for %s",
    (pattern) => {
      // Given / When
      const regex = compileSafePatternPropertyRegex(pattern);

      // Then
      expect(regex).toBeNull();
    }
  );

  it.each(["^(a)+$", "^[a+]+$", "^a\\+a+$"])(
    "accepts bounded grouping, character classes, and escapes for %s",
    (pattern) => {
      // Given / When
      const regex = compileSafePatternPropertyRegex(pattern);

      // Then
      expect(regex).toBeInstanceOf(RegExp);
    }
  );

  it.each(["(a)\\1", "(?<letter>a)\\k<letter>"])(
    "rejects backreferences for %s",
    (pattern) => {
      // Given / When
      const regex = compileSafePatternPropertyRegex(pattern);

      // Then
      expect(regex).toBeNull();
    }
  );

  it("rejects patterns beyond the bounded scan length", () => {
    // Given
    const pattern = `^${"a".repeat(128)}$`;

    // When
    const regex = compileSafePatternPropertyRegex(pattern);

    // Then
    expect(regex).toBeNull();
  });

  it("rejects invalid regular-expression syntax", () => {
    // Given / When
    const regex = compileSafePatternPropertyRegex("[");

    // Then
    expect(regex).toBeNull();
  });
});
