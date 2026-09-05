import { describe, expect, it } from "vitest";

import { countTagOccurrences } from "../../../rxml/schema/tag-occurrences";
import {
  findMatchingCloseTag,
  parseTagName,
  skipSpecialConstruct,
  skipToTagEnd,
} from "../../../rxml/schema/xml-tag-scanner";

describe("XML tag scanner coverage", () => {
  describe("skipSpecialConstruct", () => {
    it.each([
      ["<!declaration>", 1, 14],
      ["<!declaration", 1, 13],
      ["<?instruction?>", 1, 15],
      ["<?instruction", 1, 13],
      ["<element>", 1, -1],
    ])("returns the next position for %s", (xml, position, expected) => {
      // Given: an XML construct beginning immediately before position.
      const { length } = xml;

      // When: the scanner checks whether the construct is special.
      const result = skipSpecialConstruct(xml, position, length);

      // Then: scanning resumes at the expected boundary.
      expect(result).toBe(expected);
    });
  });

  describe("parseTagName", () => {
    it.each([
      { xml: "alpha-1:beta rest", position: 0, name: "alpha-1:beta", pos: 12 },
      { xml: "1alpha", position: 0, name: "", pos: 0 },
      { xml: "", position: 0, name: "", pos: 0 },
    ])("parses the name in $xml", ({ xml, position, name, pos }) => {
      // Given: source text and a candidate name position.
      const { length } = xml;

      // When: the candidate is parsed.
      const result = parseTagName(xml, position, length);

      // Then: only a valid XML name is consumed.
      expect(result).toEqual({ name, pos });
    });
  });

  describe("skipToTagEnd", () => {
    it.each([
      ['tag double=">" tail>', 3, { pos: 19, isSelfClosing: false }],
      ["tag single='>' tail/>", 3, { pos: 20, isSelfClosing: true }],
      ["tag slash/value>", 3, { pos: 15, isSelfClosing: false }],
      ["tag unfinished", 3, { pos: 14, isSelfClosing: false }],
    ])("finds the tag boundary in %s", (xml, start, expected) => {
      // Given: text positioned immediately after a tag name.
      const { length } = xml;

      // When: the remainder of the tag is scanned.
      const result = skipToTagEnd(xml, start, length);

      // Then: quoted delimiters are ignored and self-closing syntax is reported.
      expect(result).toEqual(expected);
    });
  });

  describe("findMatchingCloseTag", () => {
    it.each([
      { xml: "body</item>", expected: 4 },
      { xml: "<item>nested</item></item>", expected: 19 },
      { xml: "<item/>body</item>", expected: 11 },
      { xml: "<other></other></item>", expected: 15 },
      { xml: "<!declaration><other></other></item>", expected: 29 },
      { xml: "body", expected: -1 },
      { xml: "body<", expected: -1 },
      { xml: "<item>nested</item", expected: -1 },
      { xml: "<other></other", expected: -1 },
      { xml: "<item", expected: -1 },
    ])("finds the matching close in $xml", ({ xml, expected }) => {
      // Given: content following an opening item tag.
      const { length } = xml;

      // When: the matching close is scanned with nesting awareness.
      const result = findMatchingCloseTag(xml, 0, "item", length);

      // Then: the matching close position or absence is returned.
      expect(result).toBe(expected);
    });
  });
});

describe("tag occurrence counting coverage", () => {
  it.each([
    { xml: "plain text", ranges: undefined, skipFirst: false, expected: 0 },
    { xml: "trailing <", ranges: undefined, skipFirst: false, expected: 0 },
    { xml: "<!declaration", ranges: undefined, skipFirst: false, expected: 0 },
    {
      xml: "<!declaration><item/>",
      ranges: undefined,
      skipFirst: false,
      expected: 1,
    },
    { xml: "<?instruction", ranges: undefined, skipFirst: false, expected: 0 },
    {
      xml: "<?instruction?><item/>",
      ranges: undefined,
      skipFirst: false,
      expected: 1,
    },
    { xml: "</item", ranges: undefined, skipFirst: false, expected: 0 },
    { xml: "<item", ranges: undefined, skipFirst: false, expected: 1 },
    { xml: "<item/><item></item>", ranges: [], skipFirst: true, expected: 1 },
    {
      xml: "<other/><item/>",
      ranges: undefined,
      skipFirst: false,
      expected: 1,
    },
    {
      xml: "<item/><item/>",
      ranges: [{ start: 0, end: 7 }],
      skipFirst: false,
      expected: 1,
    },
    {
      xml: "<item/><item/>",
      ranges: [{ start: 20, end: 30 }],
      skipFirst: false,
      expected: 2,
    },
    {
      xml: "<item value=\">\"/><item value=''>'/>",
      ranges: undefined,
      skipFirst: false,
      expected: 2,
    },
    {
      xml: "<1invalid/><item/>",
      ranges: undefined,
      skipFirst: false,
      expected: 1,
    },
  ])(
    "counts target openings in $xml",
    ({ xml, ranges, skipFirst, expected }) => {
      // Given: XML-like text and optional excluded source ranges.
      const excludedRanges = ranges;

      // When: target opening tags are counted.
      const result = countTagOccurrences(
        xml,
        "item",
        excludedRanges,
        skipFirst
      );

      // Then: only eligible target openings contribute to the count.
      expect(result).toBe(expected);
    }
  );
});
