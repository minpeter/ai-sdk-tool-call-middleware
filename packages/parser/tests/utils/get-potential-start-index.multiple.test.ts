import { describe, expect, it } from "vitest";

import { getPotentialStartIndexMultiple } from "@/utils/get-potential-start-index";

describe("getPotentialStartIndexMultiple", () => {
  it("should return null for empty searchedTexts array", () => {
    expect(getPotentialStartIndexMultiple("hello", [])).toBeNull();
  });

  it("should return null when no matches found", () => {
    expect(getPotentialStartIndexMultiple("hello", ["xyz", "abc"])).toBeNull();
  });

  it("should find complete match", () => {
    const result = getPotentialStartIndexMultiple("hello world", ["world", "xyz"]);
    expect(result).toEqual({
      index: 6,
      matchedText: "world",
      isComplete: true,
    });
  });

  it("should find partial match", () => {
    const result = getPotentialStartIndexMultiple("hello wor", ["world", "xyz"]);
    expect(result).toEqual({
      index: 6,
      matchedText: "world",
      isComplete: false,
    });
  });

  it("should prefer complete matches over partial matches", () => {
    const result = getPotentialStartIndexMultiple("abc abcdef", ["abc", "abcdef"]);
    expect(result).toEqual({
      index: 0,
      matchedText: "abc",
      isComplete: true,
    });
  });

  it("should return earliest match when multiple complete matches exist", () => {
    const result = getPotentialStartIndexMultiple("abc xyz abc", ["abc", "xyz"]);
    expect(result).toEqual({
      index: 0,
      matchedText: "abc",
      isComplete: true,
    });
  });

  it("should handle multiple patterns correctly", () => {
    // This is more focused on the actual use case - finding the best match
    const result = getPotentialStartIndexMultiple("xyzab", ["abcdef", "xyzdef"]);
    // Only "ab" matches as a prefix of "abcdef" at position 3
    expect(result).toEqual({
      index: 3,
      matchedText: "abcdef",
      isComplete: false,
    });
  });

  it("should prioritize complete matches over earlier partial matches", () => {
    const result = getPotentialStartIndexMultiple("ab xyz", ["abc", "xyz"]);
    expect(result).toEqual({
      index: 3,
      matchedText: "xyz",
      isComplete: true,
    });
  });

  it("should handle empty searchedText strings", () => {
    const result = getPotentialStartIndexMultiple("hello", ["", "hello", ""]);
    expect(result).toEqual({
      index: 0,
      matchedText: "hello",
      isComplete: true,
    });
  });

  it("should handle complex real-world scenario with markdown tags", () => {
    const text = "Some text ```";
    const result = getPotentialStartIndexMultiple(text, ["```tool_call\n", "\n```", "`"]);
    
    // Should find complete match with ` since it's the first complete match found
    expect(result).toEqual({
      index: 10,
      matchedText: "`",
      isComplete: true,
    });
  });

  it("should handle complex real-world scenario with complete tag match", () => {
    const text = "Some text ` more";
    const result = getPotentialStartIndexMultiple(text, ["```", "`", "\n```"]);
    
    expect(result).toEqual({
      index: 10,
      matchedText: "`",
      isComplete: true,
    });
  });

  it("should handle multiple overlapping matches correctly", () => {
    const text = "text ```";
    const result = getPotentialStartIndexMultiple(text, ["`", "```", "```tool\n"]);
    
    // Should find complete match with ` first (at index 5) since it comes first in the array and is complete
    expect(result).toEqual({
      index: 5,
      matchedText: "`",
      isComplete: true,
    });
  });
});