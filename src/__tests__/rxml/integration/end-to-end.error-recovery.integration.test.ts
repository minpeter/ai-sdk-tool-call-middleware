import { describe, expect, it } from "vitest";

import { parseWithoutSchema } from "../../../rxml/core/parser";
import { RXMLParseError } from "../../../rxml/errors/types";

describe("robust-xml integration", () => {
  describe("error handling and recovery", () => {
    it("provides detailed error information", () => {
      const invalidXml = `
        <root>
          <item>content</wrong>
        </root>
      `;

      try {
        parseWithoutSchema(invalidXml);
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(RXMLParseError);
        const err = error as RXMLParseError;
        expect(err.message).toContain("Unexpected close tag");
        expect(err.line).toBeGreaterThan(0);
        expect(err.column).toBeGreaterThan(0);
      }
    });

    it("handles edge cases in XML content", () => {
      const edgeCaseXml = `
        <root>
          <empty></empty>
          <self_closed/>
          <with_cdata><![CDATA[<script>alert('test')</script>]]></with_cdata>
          <with_comment><!-- this is a comment -->content</with_comment>
          <with_entities>&lt;escaped&gt;</with_entities>
        </root>
      `;

      const result = parseWithoutSchema(edgeCaseXml);
      expect(result).toHaveLength(1);

      const root = result[0] as any;
      expect(root.tagName).toBe("root");
      expect(root.children).toHaveLength(5);

      const cdataNode = root.children.find(
        (child: any) => child.tagName === "with_cdata"
      );
      expect(cdataNode.children[0]).toBe("<script>alert('test')</script>");
    });

    it("handles very large XML documents", () => {
      const largeXml = `<root>${Array.from(
        { length: 1000 },
        (_, i) => `<item id="${i}">Content for item ${i}</item>`
      ).join("")}</root>`;

      const result = parseWithoutSchema(largeXml);
      expect(result).toHaveLength(1);

      const root = result[0] as any;
      expect(root.children).toHaveLength(1000);
      expect(root.children[0].attributes.id).toBe("0");
      expect(root.children[999].attributes.id).toBe("999");
    });
  });
});
