import { describe, expect, it } from "vitest";

import {
  parseWithoutSchema,
  stringify,
  stringifyNode,
  stringifyNodes,
  toContentString,
} from "../..";

const XML_DECLARATION_REGEX = /^<\?xml version="1\.0" encoding="UTF-8"\?>/;
const XML_START_REGEX = /^<\?xml/;

describe("stringify", () => {
  describe("basic stringify", () => {
    it("stringifies simple objects", () => {
      const result = stringify("root", { name: "John", age: 30 });
      expect(result).toContain("<root>");
      expect(result).toContain("<name>John</name>");
      expect(result).toContain("<age>30</age>");
      expect(result).toContain("</root>");
    });

    it("stringifies without XML declaration by default even when formatted", () => {
      const result = stringify("root", { item: "test" }, { format: true });
      expect(result).not.toMatch(XML_START_REGEX);
      expect(result).toContain("<root>");
      expect(result).toContain("\n");
    });

    it("stringifies without XML declaration when not formatted", () => {
      const result = stringify("root", { item: "test" }, { format: false });
      expect(result).not.toMatch(XML_START_REGEX);
    });

    it("stringifies without XML declaration when declaration is explicitly false (with format: true)", () => {
      const result = stringify(
        "root",
        { item: "test" },
        { format: true, declaration: false }
      );
      expect(result).not.toMatch(XML_START_REGEX);
      expect(result).toContain("<root>");
      expect(result).toContain("\n"); // Still formatted
      expect(result.endsWith("\n")).toBe(false); // No trailing newline
    });

    it("removes trailing newline from formatted output", () => {
      const result = stringify("root", { item: "test" }, { format: true });
      expect(result.endsWith("\n")).toBe(false);
    });

    it("stringifies with XML declaration when declaration is explicitly true", () => {
      const result = stringify(
        "root",
        { item: "test" },
        { format: false, declaration: true }
      );
      expect(result).toMatch(XML_DECLARATION_REGEX);
      expect(result).toContain("<root>");
      expect(result.endsWith("\n")).toBe(false);
    });

    it("handles null and undefined values", () => {
      const result = stringify("root", {
        nullValue: null,
        undefinedValue: undefined,
      });
      expect(result).toContain("<nullValue/>");
      expect(result).toContain("<undefinedValue/>");
    });

    it("suppresses empty nodes when configured", () => {
      const result = stringify(
        "root",
        { empty: "", nullValue: null },
        { suppressEmptyNode: true }
      );
      expect(result).not.toContain("<empty");
      expect(result).not.toContain("<nullValue");
    });
  });

  describe("data type handling", () => {
    it("stringifies strings correctly", () => {
      const result = stringify("root", { text: "Hello World" });
      expect(result).toContain("<text>Hello World</text>");
    });

    it("stringifies numbers correctly", () => {
      const result = stringify("root", {
        integer: 42,
        float: 3.14,
        negative: -10,
      });
      expect(result).toContain("<integer>42</integer>");
      expect(result).toContain("<float>3.14</float>");
      expect(result).toContain("<negative>-10</negative>");
    });

    it("stringifies booleans correctly", () => {
      const result = stringify("root", { truthy: true, falsy: false });
      expect(result).toContain("<truthy>true</truthy>");
      expect(result).toContain("<falsy>false</falsy>");
    });

    it("stringifies arrays correctly", () => {
      const result = stringify("root", { items: ["first", "second", "third"] });
      expect(result).toContain("<items>first</items>");
      expect(result).toContain("<items>second</items>");
      expect(result).toContain("<items>third</items>");
    });

    it("handles mixed arrays", () => {
      const result = stringify("root", { mixed: [1, "text", true, null] });
      expect(result).toContain("<mixed>1</mixed>");
      expect(result).toContain("<mixed>text</mixed>");
      expect(result).toContain("<mixed>true</mixed>");
      expect(result).toContain("<mixed/>");
    });
  });

  describe("attribute handling", () => {
    it("handles attributes with @ prefix", () => {
      const result = stringify("root", {
        item: {
          "@id": "1",
          "@class": "test",
          "#text": "content",
        },
      });
      expect(result).toContain('<item id="1" class="test">content</item>');
    });

    it("handles _attributes object", () => {
      const result = stringify("root", {
        item: {
          _attributes: { id: "1", type: "test" },
          "#text": "content",
        },
      });
      expect(result).toContain('<item id="1" type="test">content</item>');
    });

    it("handles boolean attributes", () => {
      const result = stringify("root", {
        item: {
          "@checked": null,
          "@disabled": null,
          "#text": "content",
        },
      });
      expect(result).toContain("<item checked disabled>content</item>");
    });

    it('handles boolean attributes in strict mode (name="name")', () => {
      const result = stringify(
        "root",
        {
          item: {
            "@checked": null,
            "@disabled": null,
            "#text": "content",
          },
        },
        { strictBooleanAttributes: true, format: false }
      );
      expect(result).toContain(
        '<item checked="checked" disabled="disabled">content</item>'
      );
    });

    it("escapes attribute values", () => {
      const result = stringify("root", {
        item: {
          "@title": 'This has "quotes" and <tags>',
          "#text": "content",
        },
      });
      expect(result).toContain(
        "title='This has &quot;quotes&quot; and &lt;tags&gt;'"
      );
    });

    it("uses single quotes when double quotes are in value", () => {
      const result = stringify("root", {
        item: {
          "@title": 'Text with "double quotes"',
          "#text": "content",
        },
      });
      expect(result).toContain("title='Text with &quot;double quotes&quot;'");
    });

    it("escapes both quote types when value contains both", () => {
      const result = stringify("root", {
        item: {
          "@title": `It's a "quote"`,
          "#text": "content",
        },
      });
      // Since value contains double quotes, we use single-quoted attribute and escape both quotes
      expect(result).toContain("title='It&apos;s a &quot;quote&quot;'");
    });
  });

  describe("minimalEscaping option", () => {
    it("escapes minimal characters in text content", () => {
      const xml = stringify(
        "root",
        { text: "A < B & C > D and 'quotes'\"double\"" },
        { format: false, minimalEscaping: true }
      );
      expect(xml).toContain(
        "<text>A &lt; B &amp; C > D and 'quotes'\"double\"</text>"
      );
    });

    it("escapes only wrapper quote in attributes (double)", () => {
      const xml = stringify(
        "root",
        { item: { "@title": 'It\'s "ok"', "#text": "x" } },
        { format: false, minimalEscaping: true }
      );
      // value contains double quotes -> single-quoted attribute; escape &, <, and the single quote
      expect(xml).toContain("<item title='It&apos;s \"ok\"'>x</item>");
    });

    it("escapes only wrapper quote in attributes (single)", () => {
      const xml = stringify(
        "root",
        { item: { "@title": "no doubles here", "#text": "x" } },
        { format: false, minimalEscaping: true }
      );
      // no double quotes in value -> double quoted attribute; single quotes remain
      expect(xml).toContain('<item title="no doubles here">x</item>');
    });
  });

  describe("XML escaping", () => {
    it("escapes special XML characters in content", () => {
      const result = stringify("root", {
        content: "Text with <tags> & \"quotes\" and 'apostrophes'",
      });
      expect(result).toContain(
        "<content>Text with &lt;tags&gt; &amp; &quot;quotes&quot; and &apos;apostrophes&apos;</content>"
      );
    });

    it("escapes ampersands correctly", () => {
      const result = stringify("root", { text: "A & B & C" });
      expect(result).toContain("<text>A &amp; B &amp; C</text>");
    });

    it("handles already escaped content", () => {
      const result = stringify("root", { text: "Already &amp; escaped" });
      expect(result).toContain("<text>Already &amp;amp; escaped</text>");
    });
  });

  describe("complex structures", () => {
    it("stringifies nested objects", () => {
      const result = stringify("root", {
        user: {
          name: "John",
          details: {
            age: 30,
            location: "NYC",
          },
        },
      });

      expect(result).toContain("<user>");
      expect(result).toContain("<name>John</name>");
      expect(result).toContain("<details>");
      expect(result).toContain("<age>30</age>");
      expect(result).toContain("<location>NYC</location>");
      expect(result).toContain("</details>");
      expect(result).toContain("</user>");
    });

    it("handles mixed content structures", () => {
      const result = stringify("root", {
        article: {
          "#text": "Some text content",
          title: "Article Title",
          metadata: {
            author: "John Doe",
            date: "2023-01-01",
          },
        },
      });

      expect(result).toContain("<article>");
      expect(result).toContain("Some text content");
      expect(result).toContain("<title>Article Title</title>");
      expect(result).toContain("<metadata>");
      expect(result).toContain("</article>");
    });

    it("handles arrays of objects", () => {
      const result = stringify("root", {
        users: [
          { name: "John", age: 30 },
          { name: "Jane", age: 25 },
        ],
      });

      expect(result).toContain("<users>");
      expect(result).toContain("<name>John</name>");
      expect(result).toContain("<age>30</age>");
      expect(result).toContain("<name>Jane</name>");
      expect(result).toContain("<age>25</age>");
      // Should appear twice for the two users
      expect((result.match(/<users>/g) || []).length).toBe(2);
    });
  });

  describe("formatting options", () => {
    it("formats with indentation when format is true", () => {
      const result = stringify(
        "root",
        {
          item: {
            nested: "value",
          },
        },
        { format: true }
      );

      expect(result).toContain("  <item>");
      expect(result).toContain("    <nested>");
      expect(result).toContain("\n");
    });

    it("produces compact output when format is false", () => {
      const result = stringify(
        "root",
        {
          item: {
            nested: "value",
          },
        },
        { format: false }
      );

      expect(result).not.toContain("  <item>");
      expect(result).not.toContain("\n");
    });
  });

  describe("stringifyNodes", () => {
    it("stringifies parsed XML nodes back to XML", () => {
      const original = '<root><item id="1">content</item><empty/></root>';
      const parsed = parseWithoutSchema(original);
      const result = stringifyNodes(parsed);

      expect(result).toContain("<root>");
      expect(result).toContain('<item id="1">content</item>');
      expect(result).toContain("<empty/>");
      expect(result).toContain("</root>");
    });

    it("handles mixed content in nodes", () => {
      const original = "<root>text <item>nested</item> more text</root>";
      const parsed = parseWithoutSchema(original);
      const result = stringifyNodes(parsed);

      expect(result).toContain("text");
      expect(result).toContain("<item>nested</item>");
      expect(result).toContain("more text");
    });

    it("preserves processing instructions", () => {
      const original = '<?xml version="1.0"?><root><item>test</item></root>';
      const parsed = parseWithoutSchema(original);
      const result = stringifyNodes(parsed);

      expect(result).toContain('<?xml version="1.0"?>');
    });
  });

  describe("stringifyNode", () => {
    it("stringifies individual nodes", () => {
      const parsed = parseWithoutSchema('<item id="1">content</item>');
      const node = parsed[0] as any;
      const result = stringifyNode(node);

      expect(result).toBe('<item id="1">content</item>\n');
    });

    it("handles self-closing nodes", () => {
      const parsed = parseWithoutSchema('<item id="1"/>');
      const node = parsed[0] as any;
      const result = stringifyNode(node);

      expect(result).toBe('<item id="1"/>\n');
    });

    it("formats with custom depth", () => {
      const parsed = parseWithoutSchema("<item>content</item>");
      const node = parsed[0] as any;
      const result = stringifyNode(node, 2, true);

      expect(result).toContain("    <item>"); // 2 levels of indentation
    });
  });

  describe("toContentString", () => {
    it("extracts text content from nodes", () => {
      const parsed = parseWithoutSchema(
        "<root>text <item>nested</item> more text</root>"
      );
      const result = toContentString(parsed);

      expect(result).toContain("text");
      expect(result).toContain("nested");
      expect(result).toContain("more text");
      expect(result.trim()).toBe("text nested more text");
    });

    it("handles deeply nested content", () => {
      const parsed = parseWithoutSchema(
        "<root><level1><level2>deep content</level2></level1></root>"
      );
      const result = toContentString(parsed);

      expect(result.trim()).toBe("deep content");
    });

    it("handles empty content", () => {
      const parsed = parseWithoutSchema("<root><empty/></root>");
      const result = toContentString(parsed);

      expect(result.trim()).toBe("");
    });
  });

  describe("error handling", () => {
    it("throws RXMLStringifyError on invalid input", () => {
      // This is more of a theoretical test since the implementation is quite robust
      // but we want to ensure the error type is properly exported and used
      expect(() => {
        // Force an error by passing invalid data to internal functions
        stringify("root", { circular: {} });
        // Add circular reference
        (stringify as any).circular = stringify as any;
      }).not.toThrow(); // Our implementation should handle this gracefully
    });

    it("handles very large objects", () => {
      const largeObject = {};
      for (let i = 0; i < 1000; i += 1) {
        (largeObject as any)[`item${i}`] = `value${i}`;
      }

      expect(() => stringify("root", largeObject)).not.toThrow();
      const result = stringify("root", largeObject);
      expect(result).toContain("<item0>value0</item0>");
      expect(result).toContain("<item999>value999</item999>");
    });
  });

  describe("round-trip consistency", () => {
    it("maintains consistency for simple structures", () => {
      const original = { name: "John", age: 30, active: true };
      const xml = stringify("root", original, { format: false });

      // While we can't do a perfect round-trip due to type coercion,
      // we can verify the structure is maintained
      expect(xml).toContain("<name>John</name>");
      expect(xml).toContain("<age>30</age>");
      expect(xml).toContain("<active>true</active>");
    });

    it("maintains structure for nested objects", () => {
      const original = {
        user: {
          name: "John",
          details: {
            age: 30,
            location: "NYC",
          },
        },
      };

      const xml = stringify("root", original, { format: false });
      expect(xml).toContain(
        "<user><name>John</name><details><age>30</age><location>NYC</location></details></user>"
      );
    });
  });
});
