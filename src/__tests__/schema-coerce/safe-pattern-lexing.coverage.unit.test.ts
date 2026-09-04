import { describe, expect, it } from "vitest";
import { hasAdjacentRepeatedQuantifiedAtoms } from "../../schema-coerce/safe-pattern-atoms";
import { hasNestedQuantifierRisk } from "../../schema-coerce/safe-pattern-nesting";

describe("hasAdjacentRepeatedQuantifiedAtoms", () => {
  it.each([
    ["a*a*", true],
    ["a+a+", true],
    ["a?a?", true],
    ["a{1}a{1}", true],
    ["a{1,2}a{1,2}", true],
    ["..*.*", true],
    [".*.*", true],
    ["[a]+[a]+", true],
    ["[\\]]+[\\]]+", true],
    ["\\d+\\d+", true],
    ["\\++\\+", false],
    ["a+a", false],
    ["a+^a+", false],
    ["(a+)+a+a+", true],
    ["((a))", false],
    ["(a)b", false],
    ["(?:[()]+)+", false],
    ["(a\\))+", false],
    ["(a[b)])+", false],
    ["(a", false],
    ["[a", false],
    ["[a\\", false],
    ["a{", false],
    ["a{1", false],
    ["a{x}a+", false],
    ["a{,}a{,}", true],
    ["a{}a{}", true],
    ["\\", false],
    ["$+$+", true],
    ["---", false],
  ])("classifies atom pattern %s as %s", (pattern, expected) => {
    // Given
    const inputPattern = pattern;

    // When
    const result = hasAdjacentRepeatedQuantifiedAtoms(inputPattern);

    // Then
    expect(result).toBe(expected);
  });
});

describe("hasNestedQuantifierRisk", () => {
  it.each([
    ["a*a+a?", false],
    ["a{1}", false],
    ["a{1,2}", false],
    ["a{", false],
    ["a{1", false],
    ["a{x}", false],
    ["a{}", false],
    ["\\(a+\\)", false],
    ["[()|+]+", false],
    ["[\\]]+", false],
    ["(a)", false],
    ["(a)+", false],
    ["(a+)+", true],
    ["(a|b)+", true],
    ["((a)+)+", true],
    ["(a+)", false],
    [")a+", false],
    ["(?:a)+", false],
    ["(?=a)+", false],
    ["(?!a)+", false],
    ["(?<=a)+", false],
    ["(?<!a)+", false],
    ["(?<name>a)+", false],
    ["(?<namea)+", true],
    ["(?x:a)+", true],
    ["(+)+", true],
    ["(|a)+", true],
    ["(a){,}", false],
  ])("classifies nested pattern %s as %s", (pattern, expected) => {
    // Given
    const inputPattern = pattern;

    // When
    const result = hasNestedQuantifierRisk(inputPattern);

    // Then
    expect(result).toBe(expected);
  });
});
