import { describe, expect, it } from "vitest";
import { unsafeDeniedPatternMayMatchKey } from "../../../core/utils/unsafe-pattern";

describe("unsafeDeniedPatternMayMatchKey", () => {
  it.each([
    ["", "anything", true],
    ["[", "anything", true],
    ["^", "anything", true],
    ["[a-z]", "!!!", true],
    ["[a-z]", "123", false],
    ["[a-z]", "a", true],
    ["^a", "abc", true],
    ["^a", "zab", false],
    ["a$", "zba", true],
    ["a$", "azb", false],
    ["^a$", "a", true],
    ["^a$", "ab", false],
    ["^a$", "abcdefghijklmnop", false],
    ["^ab$", "abcdefghijklmnop", true],
    ["^ab$", "ab", true],
    ["ab", "zzabzz", true],
    ["^ab$", "zz!", false],
  ] as const)("classifies %s against %s", (pattern, key, expected) => {
    expect(unsafeDeniedPatternMayMatchKey(pattern, key)).toBe(expected);
  });

  it("handles escaped literals, ranges, and unknown matchers", () => {
    expect(
      unsafeDeniedPatternMayMatchKey(String.raw`^\x61-\u0062$`, "ab")
    ).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`^[a-\d]$`, "z")).toBe(
      true
    );
    expect(unsafeDeniedPatternMayMatchKey(String.raw`^[a-\x62]$`, "b")).toBe(
      true
    );
    expect(unsafeDeniedPatternMayMatchKey(String.raw`[\d]`, "z")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`[\x61]`, "a")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`[\x00]`, "a")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey("^[^a]$", "b")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey("^[a-]$", "a")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`^[a-\x]$`, "a")).toBe(
      true
    );
    expect(unsafeDeniedPatternMayMatchKey("^[a-!]$", "a")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey("[a-b", "z")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`[\xZZ]`, "z")).toBe(false);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`[\uZZZZ]`, "z")).toBe(
      false
    );
    expect(unsafeDeniedPatternMayMatchKey(String.raw`\q`, "q")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`[\!]`, "a")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`\!`, "a")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`\x00`, "a")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`\d`, "q")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(String.raw`\?`, "?")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey(".", "x")).toBe(true);
  });

  it("covers malformed boundary syntax without throwing", () => {
    const fragments = ["^", "$", "[", "]", "-", "\\", "a", "d", "."];
    const patterns = ["", ...fragments];
    for (const first of fragments) {
      for (const second of fragments) {
        patterns.push(first + second);
      }
    }
    for (const pattern of patterns) {
      for (const key of ["", "a", "z", "-", "ab", "zz!"]) {
        expect(() =>
          unsafeDeniedPatternMayMatchKey(pattern, key)
        ).not.toThrow();
      }
    }
  });

  it("does not treat prototype-sensitive and non-comparable keys as ordinary matches", () => {
    expect(unsafeDeniedPatternMayMatchKey("^constructor$", "constructor")).toBe(
      true
    );
    expect(unsafeDeniedPatternMayMatchKey("^__proto__$", "__proto__")).toBe(
      true
    );
    expect(unsafeDeniedPatternMayMatchKey("^a$", "é")).toBe(true);
    expect(unsafeDeniedPatternMayMatchKey("^a$", "a_")).toBe(false);
  });
});
