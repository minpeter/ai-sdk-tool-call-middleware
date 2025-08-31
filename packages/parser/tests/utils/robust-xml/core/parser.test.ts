import { describe, expect, it } from "vitest";

import {
  filter,
  parse,
  parseNode,
  parseWithoutSchema,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  simplify,
} from "@/utils/robust-xml";

import {
  duplicateTagSamples,
  malformedXmlSamples,
  schemaTestCases,
  validXmlSamples,
} from "../fixtures/test-data";

describe("robust-xml parser", () => {
  describe("parseWithoutSchema", () => {
    it("parses simple XML correctly", () => {
      const result = parseWithoutSchema(validXmlSamples.simple);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        tagName: "root",
        attributes: {},
        children: [
          {
            tagName: "item",
            attributes: {},
            children: ["test"],
          },
        ],
      });
    });

    it("parses XML with attributes", () => {
      const result = parseWithoutSchema(validXmlSamples.withAttributes);
      const root = result[0] as any;
      expect(root.attributes.id).toBe("main");
      expect(root.children[0].attributes.type).toBe("test");
    });

    it("handles CDATA sections", () => {
      const result = parseWithoutSchema(validXmlSamples.withCdata);
      const root = result[0] as any;
      expect(root.children[0].children[0]).toBe("<test>content</test>");
    });

    it("handles comments when keepComments is true", () => {
      const result = parseWithoutSchema(validXmlSamples.withComments, {
        keepComments: true,
      });
      // Comments should be preserved in the structure
      const resultStr = JSON.stringify(result);
      expect(resultStr).toContain("<!-- comment -->");
      expect(resultStr).toContain("<!-- another comment -->");
    });

    it("ignores comments by default", () => {
      const result = parseWithoutSchema(validXmlSamples.withComments);
      const commentNodes = result.filter(
        node => typeof node === "string" && node.includes("<!--")
      );
      expect(commentNodes).toHaveLength(0);
    });

    it("handles processing instructions", () => {
      const result = parseWithoutSchema(
        validXmlSamples.withProcessingInstruction
      );
      expect(result[0]).toMatchObject({
        tagName: "?xml",
        attributes: {
          version: "1.0",
          encoding: "UTF-8",
        },
      });
    });

    it("handles DOCTYPE declarations", () => {
      const result = parseWithoutSchema(validXmlSamples.withDoctype);
      expect(result).toContain("!DOCTYPE root");
    });

    it("handles self-closing tags", () => {
      const result = parseWithoutSchema(validXmlSamples.selfClosing);
      const root = result[0] as any;
      expect(root.children).toHaveLength(2);
      expect(root.children[0].children).toHaveLength(0);
      expect(root.children[1].children).toHaveLength(0);
    });

    it("preserves whitespace when keepWhitespace is true", () => {
      const xml = "<root>  <item>  test  </item>  </root>";
      const result = parseWithoutSchema(xml, { keepWhitespace: true });
      const root = result[0] as any;
      expect(root.children).toContain("  ");
    });

    it("trims whitespace by default", () => {
      const xml = "<root>  <item>  test  </item>  </root>";
      const result = parseWithoutSchema(xml);
      const root = result[0] as any;
      const textNodes = root.children.filter(
        (child: any) => typeof child === "string"
      );
      expect(textNodes).toHaveLength(0);
    });
  });

  describe("parseNode", () => {
    it("parses a single node", () => {
      const result = parseNode('<item attr="value">content</item>');
      expect(result).toMatchObject({
        tagName: "item",
        attributes: { attr: "value" },
        children: ["content"],
      });
    });

    it("handles self-closing single node", () => {
      const result = parseNode('<item attr="value"/>');
      expect(result).toMatchObject({
        tagName: "item",
        attributes: { attr: "value" },
        children: [],
      });
    });
  });

  describe("parse with schema", () => {
    it("parses and coerces string properties", () => {
      const result = parse(
        schemaTestCases.stringProperty.xml,
        schemaTestCases.stringProperty.schema
      );
      expect(result).toEqual(schemaTestCases.stringProperty.expected);
    });

    it("parses and coerces number properties", () => {
      const result = parse(
        schemaTestCases.numberProperty.xml,
        schemaTestCases.numberProperty.schema
      );
      expect(result).toEqual(schemaTestCases.numberProperty.expected);
    });

    it("parses and coerces boolean properties", () => {
      const result = parse(
        schemaTestCases.booleanProperty.xml,
        schemaTestCases.booleanProperty.schema
      );
      expect(result).toEqual(schemaTestCases.booleanProperty.expected);
    });

    it("parses and coerces array properties", () => {
      const result = parse(
        schemaTestCases.arrayProperty.xml,
        schemaTestCases.arrayProperty.schema
      );
      expect(result).toEqual(schemaTestCases.arrayProperty.expected);
    });

    it("parses and coerces object properties", () => {
      const result = parse(
        schemaTestCases.objectProperty.xml,
        schemaTestCases.objectProperty.schema
      );
      expect(result).toEqual(schemaTestCases.objectProperty.expected);
    });

    it("handles custom textNodeName", () => {
      const xml = '<value kind="n"> 10.5 </value>';
      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
        additionalProperties: false,
      };
      const result = parse(xml, schema, { textNodeName: "_text" });
      expect(result).toEqual({ value: 10.5 });
    });
  });

  describe("duplicate tag handling", () => {
    it("throws RXMLDuplicateStringTagError for duplicate string tags by default", () => {
      const schema = {
        type: "object",
        properties: { content: { type: "string" } },
      };
      expect(() => parse(duplicateTagSamples.stringDuplicates, schema)).toThrow(
        RXMLDuplicateStringTagError
      );
    });

    it("handles duplicates gracefully when throwOnDuplicateStringTags is false", () => {
      const schema = {
        type: "object",
        properties: { content: { type: "string" } },
      };
      const result = parse(duplicateTagSamples.stringDuplicates, schema, {
        throwOnDuplicateStringTags: false,
      });
      expect(result.content).toBe("First"); // Should use first occurrence
    });
  });

  describe("error handling", () => {
    it("handles malformed XML gracefully", () => {
      expect(() => parseWithoutSchema(malformedXmlSamples.unclosedTag)).toThrow(
        RXMLParseError
      );
    });

    it("throws RXMLParseError for mismatched tags", () => {
      expect(() =>
        parseWithoutSchema(malformedXmlSamples.mismatchedTags)
      ).toThrow(RXMLParseError);
    });

    it("handles unclosed attributes gracefully", () => {
      // Should not throw, but handle gracefully
      const result = parseWithoutSchema(malformedXmlSamples.unclosedAttribute);
      expect(result).toBeDefined();
    });
  });

  describe("simplify", () => {
    it("simplifies parsed XML structure", () => {
      const parsed = parseWithoutSchema("<test><cc>one</cc><dd></dd></test>");
      const simplified = simplify(parsed);
      expect(simplified).toMatchObject({
        test: {
          cc: "one",
          dd: "",
        },
      });
    });

    it("handles arrays in simplification", () => {
      const parsed = parseWithoutSchema(
        "<test><cc>one</cc><cc>two</cc></test>"
      );
      const simplified = simplify(parsed);
      expect(simplified.test.cc).toEqual(["one", "two"]);
    });

    it("preserves attributes in simplification", () => {
      const parsed = parseWithoutSchema(
        '<test><cc attr="value">content</cc></test>'
      );
      const simplified = simplify(parsed);
      expect(simplified.test.cc._attributes).toEqual({ attr: "value" });
    });
  });

  describe("filter", () => {
    it("filters nodes based on predicate", () => {
      const parsed = parseWithoutSchema(
        '<root><item id="1">first</item><item id="2">second</item><other>test</other></root>'
      );
      const filtered = filter(parsed, node => node.tagName === "item");
      expect(filtered).toHaveLength(2);
      expect(filtered[0].tagName).toBe("item");
      expect(filtered[1].tagName).toBe("item");
    });

    it("filters with complex predicates", () => {
      const parsed = parseWithoutSchema(
        '<root><item type="a">first</item><item type="b">second</item></root>'
      );
      const filtered = filter(parsed, node => node.attributes.type === "a");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].attributes.type).toBe("a");
    });
  });

  describe("edge cases", () => {
    it("handles empty XML", () => {
      const result = parseWithoutSchema("");
      expect(result).toEqual([]);
    });

    it("handles XML with only whitespace", () => {
      const result = parseWithoutSchema("   \n  \t  ");
      expect(result).toEqual([]);
    });

    it("handles mixed content correctly", () => {
      const result = parseWithoutSchema(validXmlSamples.mixedContent);
      const root = result[0] as any;
      expect(root.children).toHaveLength(3); // "text before ", item element, " text after"
      expect(root.children[0]).toBe("text before");
      expect(root.children[2]).toBe("text after");
    });

    it("handles nested empty elements", () => {
      const result = parseWithoutSchema(validXmlSamples.emptyElements);
      const root = result[0] as any;
      expect(root.children).toHaveLength(2);
      expect(root.children[0].children).toEqual([]);
      expect(root.children[1].children).toEqual([]);
    });
  });
});
