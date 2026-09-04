import { describe, expect, it } from "vitest";

import { parseWithoutSchema } from "../../../rxml/core/parser";
import type { RXMLNode } from "../../../rxml/core/types";
import { RXMLParseError } from "../../../rxml/errors/types";

const isRXMLNode = (value: RXMLNode | string | undefined): value is RXMLNode =>
  typeof value === "object";

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
        if (!(error instanceof RXMLParseError)) {
          throw error;
        }
        expect(error).toBeInstanceOf(RXMLParseError);
        expect(error.message).toContain("Unexpected close tag");
        expect(error.line).toBeGreaterThan(0);
        expect(error.column).toBeGreaterThan(0);
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

      const [root] = result;
      if (!isRXMLNode(root)) {
        expect.fail("root was not an XML node");
      }
      expect(root.tagName).toBe("root");
      expect(root.children).toHaveLength(5);

      const cdataNode = root.children.find(
        (child): child is RXMLNode =>
          isRXMLNode(child) && child.tagName === "with_cdata"
      );
      if (!cdataNode) {
        expect.fail("with_cdata node was not found");
      }
      expect(cdataNode.children[0]).toBe("<script>alert('test')</script>");
    });

    it("handles very large XML documents", () => {
      const largeXml = `<root>${Array.from(
        { length: 1000 },
        (_, i) => `<item id="${i}">Content for item ${i}</item>`
      ).join("")}</root>`;

      const result = parseWithoutSchema(largeXml);
      expect(result).toHaveLength(1);

      const [root] = result;
      if (!isRXMLNode(root)) {
        expect.fail("root was not an XML node");
      }
      const [firstChild] = root.children;
      const lastChild = root.children.at(-1);
      if (!(isRXMLNode(firstChild) && isRXMLNode(lastChild))) {
        expect.fail("root children were not XML nodes");
      }
      expect(root.children).toHaveLength(1000);
      expect(firstChild.attributes.id).toBe("0");
      expect(lastChild.attributes.id).toBe("999");
    });
  });
});
