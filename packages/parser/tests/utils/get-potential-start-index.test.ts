import { describe, it, expect } from "vitest";
import { getPotentialStartIndex } from "@/utils/get-potential-start-index";

describe("getPotentialStartIndex", () => {
  describe("direct substring matches", () => {
    it("should find exact substring at the beginning", () => {
      expect(getPotentialStartIndex("hello world", "hello")).toBe(0);
    });

    it("should find exact substring in the middle", () => {
      expect(getPotentialStartIndex("hello world", "world")).toBe(6);
    });

    it("should find exact substring at the end", () => {
      expect(getPotentialStartIndex("hello world", "orld")).toBe(7);
    });

    it("should find the first occurrence for multiple matches", () => {
      expect(getPotentialStartIndex("abcabc", "abc")).toBe(0);
    });

    it("should handle single character matches", () => {
      expect(getPotentialStartIndex("hello", "h")).toBe(0);
      expect(getPotentialStartIndex("hello", "e")).toBe(1);
      expect(getPotentialStartIndex("hello", "o")).toBe(4);
    });

    it("should find complete text match", () => {
      expect(getPotentialStartIndex("hello", "hello")).toBe(0);
    });
  });

  describe("partial suffix-prefix matches", () => {
    it("should find partial match at the end (suffix matches prefix)", () => {
      expect(getPotentialStartIndex("hello wo", "world")).toBe(6);
    });

    it("should find single character suffix match", () => {
      expect(getPotentialStartIndex("hello w", "world")).toBe(6);
    });

    it("should find longer partial matches", () => {
      expect(getPotentialStartIndex("hello wor", "world")).toBe(6);
    });

    it("should prioritize complete matches over partial", () => {
      // If "test" exists completely, it should return that index
      // even if there's also a partial match at the end
      expect(getPotentialStartIndex("test data tes", "test")).toBe(0);
    });

    it("should handle overlapping patterns", () => {
      expect(getPotentialStartIndex("abcab", "abcd")).toBe(3);
    });
  });

  describe("no matches", () => {
    it("should return null when no match is found", () => {
      expect(getPotentialStartIndex("hello", "xyz")).toBe(null);
    });

    it("should return null when searched text is longer than text", () => {
      expect(getPotentialStartIndex("hi", "hello")).toBe(null);
    });

    it("should return null for completely different strings", () => {
      expect(getPotentialStartIndex("abc", "def")).toBe(null);
    });

    it("should handle case sensitivity", () => {
      expect(getPotentialStartIndex("Hello", "hello")).toBe(null);
      expect(getPotentialStartIndex("hello", "Hello")).toBe(null);
    });
  });

  describe("edge cases", () => {
    it("should return null for empty searchedText", () => {
      expect(getPotentialStartIndex("hello", "")).toBe(null);
    });

    it("should handle empty text", () => {
      expect(getPotentialStartIndex("", "hello")).toBe(null);
    });

    it("should handle both empty", () => {
      expect(getPotentialStartIndex("", "")).toBe(null);
    });

    it("should handle special characters", () => {
      expect(getPotentialStartIndex("hello@world.com", "@world")).toBe(5);
      expect(getPotentialStartIndex("test$123", "$123")).toBe(4);
      expect(getPotentialStartIndex("data[0]", "[0]")).toBe(4);
    });

    it("should handle unicode characters", () => {
      expect(getPotentialStartIndex("hello 😀 world", "😀")).toBe(6);
      expect(getPotentialStartIndex("你好世界", "世界")).toBe(2);
    });

    it("should handle whitespace", () => {
      expect(getPotentialStartIndex("hello world", " ")).toBe(5);
      expect(getPotentialStartIndex("  spaces  ", "  ")).toBe(0);
      expect(getPotentialStartIndex("tab\ttab", "\t")).toBe(3);
    });

    it("should handle newlines", () => {
      expect(getPotentialStartIndex("line1\nline2", "\n")).toBe(5);
      expect(getPotentialStartIndex("line1\nli", "line2")).toBe(6);
    });
  });

  describe("performance considerations", () => {
    it("should handle long strings efficiently", () => {
      const longText = "a".repeat(1000) + "b";
      expect(getPotentialStartIndex(longText, "b")).toBe(1000);
    });

    it("should handle long searched text", () => {
      const text = "start";
      const searchedText = "a".repeat(1000);
      expect(getPotentialStartIndex(text, searchedText)).toBe(null);
    });

    it("should find partial match in long string", () => {
      const text = "a".repeat(1000) + "abc";
      const searchedText = "abcdef";
      expect(getPotentialStartIndex(text, searchedText)).toBe(1000);
    });
  });

  describe("realistic use cases", () => {
    it("should find JSON object start", () => {
      const text = 'Some text before {"name": "val';
      const searchedText = '{"name": "value"}';
      expect(getPotentialStartIndex(text, searchedText)).toBe(17);
    });

    it("should find tool call tag start", () => {
      const text = "Response text <tool_ca";
      const searchedText = "<tool_call>";
      expect(getPotentialStartIndex(text, searchedText)).toBe(14);
    });

    it("should find markdown code block start", () => {
      const text = "Some explanation ```jav";
      const searchedText = "```javascript";
      expect(getPotentialStartIndex(text, searchedText)).toBe(17);
    });

    it("should handle streaming response chunks", () => {
      // Simulating a streaming response where text is incomplete
      const chunk1 = "The answer is";
      const chunk2 = "The answer is <too";
      const searchedText = "<tool_call>";

      expect(getPotentialStartIndex(chunk1, searchedText)).toBe(null);
      expect(getPotentialStartIndex(chunk2, searchedText)).toBe(14);
    });
  });
});
