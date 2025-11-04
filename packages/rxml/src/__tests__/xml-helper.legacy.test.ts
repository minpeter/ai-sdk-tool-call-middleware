import { describe, expect, it } from "vitest";

import {
  countTagOccurrences,
  extractRawInner,
  findFirstTopLevelRange,
} from "..";

// Constants
const EXPECTED_TAG_COUNT = 3;

describe("XML helper utilities", () => {
  describe("extractRawInner", () => {
    it("returns inner text for simple tag", () => {
      const xml = "<content>Hello</content>";
      expect(extractRawInner(xml, "content")).toBe("Hello");
    });

    it("returns empty string for self-closing tag", () => {
      const xml = "<content/>";
      expect(extractRawInner(xml, "content")).toBe("");
    });

    it("prefers the shallowest top-level occurrence when nested and sibling both exist", () => {
      const xml =
        "<outer><content>nested</content></outer><content>top</content>";
      expect(extractRawInner(xml, "content")).toBe("top");
    });

    it("handles attributes including quotes and '>' and preserves only inner raw content", () => {
      const inner = "Some <b>text</b>";
      const xml = `<content data="a > b" note="it's ok">${inner}</content>`;
      expect(extractRawInner(xml, "content")).toBe(inner);
    });

    it("preserves CDATA and ignores comments/PI around it", () => {
      const inner = "<![CDATA[<encoding>not-sibling</encoding>]]>";
      const xml = `<!-- lead --?><content>${inner}</content><?pi done?>`;
      expect(extractRawInner(xml, "content")).toBe(inner);
    });

    it("handles nested same-named tags by returning the content up to the matching close at same depth", () => {
      const xml = "<content>a<content>b</content>c</content>";
      expect(extractRawInner(xml, "content")).toBe("a<content>b</content>c");
    });
  });

  describe("findFirstTopLevelRange", () => {
    it("returns start/end for simple tag and slices to inner", () => {
      const inner = "Hello";
      const xml = `<content>${inner}</content>`;
      const r = findFirstTopLevelRange(xml, "content");
      expect(r).toBeDefined();
      expect(xml.slice(r?.start ?? 0, r?.end ?? 0)).toBe(inner);
    });

    it("returns empty range for self-closing tag", () => {
      const xml = "<content/>";
      const r = findFirstTopLevelRange(xml, "content");
      expect(r).toBeDefined();
      expect(r?.start).toBe(r?.end);
      expect(xml.slice(r?.start ?? 0, r?.end ?? 0)).toBe("");
    });

    it("ignores nested occurrence and selects top-level sibling occurrence", () => {
      const xml =
        "<outer><content>nested</content></outer><content>top</content>";
      const r = findFirstTopLevelRange(xml, "content");
      expect(r).toBeDefined();
      expect(xml.slice(r?.start ?? 0, r?.end ?? 0)).toBe("top");
    });

    it("handles attributes with quotes and '>'", () => {
      const inner = "X";
      const xml = `<content data=">" note='a > b'>${inner}</content>`;
      const r = findFirstTopLevelRange(xml, "content");
      expect(r).toBeDefined();
      expect(xml.slice(r?.start ?? 0, r?.end ?? 0)).toBe(inner);
    });

    it("skips comments, CDATA, and processing instructions while searching", () => {
      const inner = "Y";
      const xml = `<!-- c --><![CDATA[ z ]]><?pi?> <content>${inner}</content>`;
      const r = findFirstTopLevelRange(xml, "content");
      expect(r).toBeDefined();
      expect(xml.slice(r?.start ?? 0, r?.end ?? 0)).toBe(inner);
    });
  });

  describe("countTagOccurrences", () => {
    it("counts additional occurrences after the first (default skipFirst=true)", () => {
      const xml = "<content>a</content><content>b</content><content/>";
      // First occurrence is skipped, so we count the remaining 2
      expect(countTagOccurrences(xml, "content")).toBe(2);
    });

    it("counts all occurrences when skipFirst=false", () => {
      const xml = "<content>a</content><content>b</content><content/>";
      expect(countTagOccurrences(xml, "content", undefined, false)).toBe(
        EXPECTED_TAG_COUNT
      );
    });

    it("excludes ranges, ignoring nested occurrence inside excluded sibling", () => {
      const xml =
        "<other><content>nested</content></other><content>one</content><content>two</content>";
      const other = findFirstTopLevelRange(xml, "other");
      const excluded = other ? [other] : [];
      // With exclusion, the first non-excluded occurrence is <content>one</content> which gets skipped, so only "two" remains
      expect(countTagOccurrences(xml, "content", excluded, true)).toBe(1);
      // Without exclusion, first occurrence is the nested one; skip it, count both top-level ones
      expect(countTagOccurrences(xml, "content", undefined, true)).toBe(2);
    });

    it("ignores occurrences inside comments and CDATA", () => {
      const xml =
        "<!-- <content>x</content> --><![CDATA[ <content>y</content> ]]><content>z</content>";
      // skipFirst=true: the only counted after skipping the first (which is the top-level one) would be 0
      expect(countTagOccurrences(xml, "content", undefined, true)).toBe(0);
      // skipFirst=false: count only the real element occurrence
      expect(countTagOccurrences(xml, "content", undefined, false)).toBe(1);
    });

    it("handles attributes with quotes and angle brackets in values", () => {
      const xml = `<content data=">" note='a > b'>x</content><content data="<tag>">y</content>`;
      // skipFirst=true: only the second occurrence should be counted
      expect(countTagOccurrences(xml, "content", undefined, true)).toBe(1);
      // skipFirst=false: both should be counted
      expect(countTagOccurrences(xml, "content", undefined, false)).toBe(2);
    });
  });
});
