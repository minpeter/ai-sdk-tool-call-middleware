import { describe, expect, it } from "vitest";

import { RXMLParseError, XMLTokenizer } from "@/index";

describe("XMLTokenizer", () => {
  const isNode = (
    value: unknown
  ): value is {
    tagName: string;
    attributes: Record<string, unknown>;
    children: unknown[];
  } =>
    typeof value === "object" &&
    value !== null &&
    "tagName" in (value as Record<string, unknown>) &&
    "children" in (value as Record<string, unknown>);
  describe("basic parsing", () => {
    it("parses simple elements", () => {
      const tokenizer = new XMLTokenizer("<item>test</item>");
      const result = tokenizer.parseNode();
      expect(result).toMatchObject({
        tagName: "item",
        attributes: {},
        children: ["test"],
      });
    });

    it("parses elements with attributes", () => {
      const tokenizer = new XMLTokenizer(
        '<item id="1" type="test">content</item>'
      );
      const result = tokenizer.parseNode();
      expect(result).toMatchObject({
        tagName: "item",
        attributes: { id: "1", type: "test" },
        children: ["content"],
      });
    });

    it("parses self-closing elements", () => {
      const tokenizer = new XMLTokenizer('<item id="1"/>');
      const result = tokenizer.parseNode();
      expect(result).toMatchObject({
        tagName: "item",
        attributes: { id: "1" },
        children: [],
      });
    });

    it("parses nested elements", () => {
      const tokenizer = new XMLTokenizer("<root><child>content</child></root>");
      const result = tokenizer.parseNode();
      expect(result).toMatchObject({
        tagName: "root",
        attributes: {},
        children: [
          {
            tagName: "child",
            attributes: {},
            children: ["content"],
          },
        ],
      });
    });
  });

  describe("attribute parsing", () => {
    it("parses attributes with double quotes", () => {
      const tokenizer = new XMLTokenizer('<item attr="value">content</item>');
      const result = tokenizer.parseNode();
      expect(result.attributes.attr).toBe("value");
    });

    it("parses attributes with single quotes", () => {
      const tokenizer = new XMLTokenizer("<item attr='value'>content</item>");
      const result = tokenizer.parseNode();
      expect(result.attributes.attr).toBe("value");
    });

    it("parses boolean attributes (no value)", () => {
      const tokenizer = new XMLTokenizer("<item checked>content</item>");
      const result = tokenizer.parseNode();
      expect(result.attributes.checked).toBeNull();
    });

    it("handles multiple attributes", () => {
      const tokenizer = new XMLTokenizer(
        '<item id="1" class="test" disabled>content</item>'
      );
      const result = tokenizer.parseNode();
      expect(result.attributes).toEqual({
        id: "1",
        class: "test",
        disabled: null,
      });
    });

    it("handles attributes with special characters", () => {
      const tokenizer = new XMLTokenizer(
        '<item data-test="value with spaces" url="http://example.com?a=1&b=2">content</item>'
      );
      const result = tokenizer.parseNode();
      expect(result.attributes["data-test"]).toBe("value with spaces");
      expect(result.attributes.url).toBe("http://example.com?a=1&b=2");
    });
  });

  describe("special content handling", () => {
    it("handles CDATA sections", () => {
      const tokenizer = new XMLTokenizer(
        "<item><![CDATA[<test>content</test>]]></item>"
      );
      const result = tokenizer.parseNode();
      expect(result.children[0]).toBe("<test>content</test>");
    });

    it("handles unclosed CDATA sections", () => {
      const tokenizer = new XMLTokenizer(
        "<item><![CDATA[unclosed content</item>"
      );
      const result = tokenizer.parseNode();
      expect(result.children[0]).toBe("unclosed content</item>");
    });

    it("handles comments when keepComments is true", () => {
      const tokenizer = new XMLTokenizer(
        "<root><!-- comment --><item>test</item></root>",
        { keepComments: true }
      );
      const result = tokenizer.parseNode();
      expect(result.children).toContain("<!-- comment -->");
    });

    it("ignores comments by default", () => {
      const tokenizer = new XMLTokenizer(
        "<root><!-- comment --><item>test</item></root>"
      );
      const result = tokenizer.parseNode();
      const commentNodes = result.children.filter(
        child => typeof child === "string" && child.includes("<!--")
      );
      expect(commentNodes).toHaveLength(0);
    });

    it("handles DOCTYPE declarations", () => {
      const tokenizer = new XMLTokenizer(
        "<!DOCTYPE root><root><item>test</item></root>"
      );
      const result = tokenizer.parseChildren();
      expect(result).toContain("!DOCTYPE root");
    });

    it("handles processing instructions", () => {
      const tokenizer = new XMLTokenizer(
        '<?xml version="1.0"?><root><item>test</item></root>'
      );
      const result = tokenizer.parseChildren();
      expect(result[0]).toMatchObject({
        tagName: "?xml",
        attributes: { version: "1.0" },
      });
    });
  });

  describe("script and style tag handling", () => {
    it("handles script tags with special content", () => {
      const tokenizer = new XMLTokenizer(
        '<script>function test() { return "<div>"; }</script>'
      );
      const result = tokenizer.parseNode();
      expect(result.children[0]).toBe('function test() { return "<div>"; }');
    });

    it("handles style tags with CSS content", () => {
      const tokenizer = new XMLTokenizer(
        '<style>p { color: "red"; background: url("image.png"); }</style>'
      );
      const result = tokenizer.parseNode();
      expect(result.children[0]).toBe(
        'p { color: "red"; background: url("image.png"); }'
      );
    });

    it("handles unclosed script tags", () => {
      const tokenizer = new XMLTokenizer(
        '<script>function test() { return "test"; }'
      );
      const result = tokenizer.parseNode();
      expect(result.children[0]).toBe('function test() { return "test"; }');
    });
  });

  describe("whitespace handling", () => {
    it("preserves whitespace when keepWhitespace is true", () => {
      const tokenizer = new XMLTokenizer(
        "<root>  <item>  content  </item>  </root>",
        { keepWhitespace: true }
      );
      const result = tokenizer.parseNode();
      expect(result.children).toContain("  ");
    });

    it("trims whitespace by default", () => {
      const tokenizer = new XMLTokenizer(
        "<root>  <item>  content  </item>  </root>"
      );
      const result = tokenizer.parseNode();
      const whitespaceNodes = result.children.filter(
        child => typeof child === "string" && /^\s+$/.test(child)
      );
      expect(whitespaceNodes).toHaveLength(0);
    });

    it("preserves significant whitespace in text content", () => {
      const tokenizer = new XMLTokenizer(
        "<item>  significant  whitespace  </item>"
      );
      const result = tokenizer.parseNode();
      expect(result.children[0]).toBe("significant  whitespace");
    });
  });

  describe("error handling and tolerance", () => {
    it("throws error for mismatched closing tags", () => {
      const tokenizer = new XMLTokenizer(
        "<root><item>content</different></root>"
      );
      expect(() => tokenizer.parseNode()).toThrow(RXMLParseError);
    });

    it("handles unclosed attributes gracefully", () => {
      const tokenizer = new XMLTokenizer('<item attr="unclosed>content</item>');
      const result = tokenizer.parseNode();
      expect(result.tagName).toBe("item");
      // Should handle gracefully without throwing
    });

    it("handles deeply nested structures", () => {
      const deepXml =
        "<root>" +
        "<level>".repeat(100) +
        "content" +
        "</level>".repeat(100) +
        "</root>";
      const tokenizer = new XMLTokenizer(deepXml);
      const result = tokenizer.parseNode();
      expect(result.tagName).toBe("root");
    });

    it("provides line and column information in errors", () => {
      const xmlWithError = `<root>
        <item>content</wrong>
      </root>`;
      const tokenizer = new XMLTokenizer(xmlWithError);
      try {
        tokenizer.parseNode();
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(RXMLParseError);
        const err = error as RXMLParseError;
        expect(err.line).toBeDefined();
        expect(err.column).toBeDefined();
      }
    });
  });

  describe("position tracking", () => {
    it("tracks position correctly", () => {
      const tokenizer = new XMLTokenizer(
        "<item>content</item><next>more</next>"
      );
      tokenizer.parseNode();
      const position = tokenizer.getPosition();
      expect(position).toBeGreaterThan(0);

      tokenizer.setPosition(position);
      const nextNode = tokenizer.parseNode();
      expect(nextNode.tagName).toBe("next");
    });

    it("handles position at start", () => {
      const tokenizer = new XMLTokenizer("<item>content</item>", { pos: 0 });
      const result = tokenizer.parseNode();
      expect(result.tagName).toBe("item");
    });

    it("handles position in middle of content", () => {
      const tokenizer = new XMLTokenizer("prefix<item>content</item>", {
        pos: 6,
      });
      const result = tokenizer.parseNode();
      expect(result.tagName).toBe("item");
    });
  });

  describe("noChildNodes option", () => {
    it("respects noChildNodes setting for HTML elements", () => {
      const tokenizer = new XMLTokenizer(
        '<div><br><img src="test.jpg"><p>content</p></div>'
      );
      const result = tokenizer.parseNode();

      const br = result.children.find((child: any) => child.tagName === "br");
      const img = result.children.find((child: any) => child.tagName === "img");
      const p = result.children.find((child: any) => child.tagName === "p");

      if (isNode(br)) {
        expect(br.children).toEqual([]);
      } else {
        expect.fail("br was not a node");
      }
      if (isNode(img)) {
        expect(img.children).toEqual([]);
      } else {
        expect.fail("img was not a node");
      }
      if (isNode(p)) {
        expect(p.children).toEqual(["content"]);
      } else {
        expect.fail("p was not a node");
      }
    });

    it("allows custom noChildNodes configuration", () => {
      const tokenizer = new XMLTokenizer(
        "<root><custom>should be empty</custom></root>",
        {
          noChildNodes: ["custom"],
        }
      );
      const result = tokenizer.parseNode();
      const custom = result.children.find(
        (child: any) => child.tagName === "custom"
      );
      if (isNode(custom)) {
        expect(custom.children).toEqual([]);
      } else {
        expect.fail("custom was not a node");
      }
    });
  });
});
