import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as RXML from "@/index";

import { schemaTestCases } from "../fixtures/test-data";

describe("robust-xml integration", () => {
  describe("complete parsing workflow", () => {
    it("handles complex XML with schema coercion", () => {
      const xml = `
        <tool_call>
          <name>get_weather</name>
          <parameters>
            <location>San Francisco</location>
            <unit>celsius</unit>
            <include_forecast>true</include_forecast>
            <days>5</days>
          </parameters>
        </tool_call>
      `;

      const schema = z.toJSONSchema(
        z.object({
          name: z.string(),
          parameters: z.object({
            location: z.string(),
            unit: z.string(),
            include_forecast: z.boolean(),
            days: z.number(),
          }),
        })
      );

      const result = RXML.parse(xml, schema);
      expect(result).toEqual({
        name: "get_weather",
        parameters: {
          location: "San Francisco",
          unit: "celsius",
          include_forecast: true,
          days: 5,
        },
      });
    });

    it("handles malformed XML gracefully with error recovery", () => {
      const malformedXml = `
        <tool_call>
          <name>test_function</name>
          <parameters>
            <value>some content with <unclosed tag
            <another>properly closed</another>
          </parameters>
        </tool_call>
      `;

      // Should not throw but handle gracefully
      expect(() => {
        const result = RXML.parseWithoutSchema(malformedXml);
        expect(result).toBeDefined();
      }).not.toThrow();
    });

    it("preserves raw string content for string-typed properties", () => {
      const xml = `
        <response>
          <message>Hello <em>world</em>! This has <strong>HTML</strong> content.</message>
          <count>42</count>
        </response>
      `;

      const schema = z.toJSONSchema(
        z.object({
          message: z.string(),
          count: z.number(),
        })
      );

      const result = RXML.parse(xml, schema);
      expect(result.message).toBe(
        "Hello <em>world</em>! This has <strong>HTML</strong> content."
      );
      expect(result.count).toBe(42);
    });

    it("handles duplicate string tags appropriately", () => {
      const xml = `
        <data>
          <description>First description</description>
          <value>100</value>
          <description>Second description</description>
        </data>
      `;

      const schema = z.toJSONSchema(
        z.object({
          description: z.string(),
          value: z.number(),
        })
      );

      // Should throw by default
      expect(() => RXML.parse(xml, schema)).toThrow(
        RXML.RXMLDuplicateStringTagError
      );

      // Should handle gracefully when configured
      const result = RXML.parse(xml, schema, {
        throwOnDuplicateStringTags: false,
      });
      expect(result.description).toBe("First description");
      expect(result.value).toBe(100);
    });
  });

  describe("round-trip processing", () => {
    it("can parse and stringify simple structures", () => {
      const original = {
        tool_name: "get_weather",
        parameters: {
          location: "New York",
          format: "json",
        },
      };

      const xml = RXML.stringify("tool_call", original);
      expect(xml).toContain("<tool_call>");
      expect(xml).toContain("<tool_name>get_weather</tool_name>");
      expect(xml).toContain("<location>New York</location>");
      expect(xml).toContain("<format>json</format>");
    });

    it("maintains data types through schema-aware parsing", () => {
      const testCases = Object.values(schemaTestCases);

      for (const testCase of testCases) {
        const result = RXML.parse(testCase.xml, testCase.schema);
        expect(result).toEqual(testCase.expected);
      }
    });
  });

  describe("error handling and recovery", () => {
    it("provides detailed error information", () => {
      const invalidXml = `
        <root>
          <item>content</wrong>
        </root>
      `;

      try {
        RXML.parseWithoutSchema(invalidXml);
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(RXML.RXMLParseError);
        const err = error as RXML.RXMLParseError;
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

      const result = RXML.parseWithoutSchema(edgeCaseXml);
      expect(result).toHaveLength(1);

      const root = result[0] as any;
      expect(root.tagName).toBe("root");
      expect(root.children).toHaveLength(5);

      // Find CDATA content
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

      const result = RXML.parseWithoutSchema(largeXml);
      expect(result).toHaveLength(1);

      const root = result[0] as any;
      expect(root.children).toHaveLength(1000);
      expect(root.children[0].attributes.id).toBe("0");
      expect(root.children[999].attributes.id).toBe("999");
    });
  });

  describe("compatibility with existing code", () => {
    it("maintains API compatibility", () => {
      // Test that all expected exports are available
      expect(typeof RXML.parse).toBe("function");
      expect(typeof RXML.stringify).toBe("function");
      expect(typeof RXML.parseWithoutSchema).toBe("function");
      expect(typeof RXML.simplify).toBe("function");
      expect(typeof RXML.filter).toBe("function");

      // Test error classes
      expect(RXML.RXMLParseError).toBeDefined();
      expect(RXML.RXMLDuplicateStringTagError).toBeDefined();
      expect(RXML.RXMLCoercionError).toBeDefined();
      expect(RXML.RXMLStringifyError).toBeDefined();

      // Test utility functions
      expect(typeof RXML.extractRawInner).toBe("function");
      expect(typeof RXML.findFirstTopLevelRange).toBe("function");
      expect(typeof RXML.countTagOccurrences).toBe("function");
    });

    it("works with the existing test cases", () => {
      // Test case from the original robust-xml tests
      const xml = `<location>San Francisco</location>`;
      const schema = z.toJSONSchema(
        z.object({
          location: z.string(),
        })
      );
      const result = RXML.parse(xml, schema);
      expect(result).toEqual({ location: "San Francisco" });
    });

    it("handles the item list normalization pattern", () => {
      const xml = `<numbers><item> 1 </item><item>2</item><item>1e2</item></numbers>`;
      const schema = z.toJSONSchema(
        z.object({
          numbers: z.array(z.number()),
        })
      );
      const result = RXML.parse(xml, schema);
      expect(result).toEqual({ numbers: [1, 2, 100] });
    });

    it("handles nested element structure with text nodes", () => {
      const xml = `<obj><name attr="x"> John Doe </name></obj>`;
      const schema = z.toJSONSchema(
        z.object({
          obj: z.object({ name: z.string() }).passthrough(),
        })
      );
      const result = RXML.parse(xml, schema);
      expect(result).toEqual({
        obj: { name: { "#text": "John Doe", "@_attr": "x" } },
      });
    });
  });

  describe("performance characteristics", () => {
    it("handles reasonable performance for medium-sized documents", () => {
      const mediumXml = `<data>${Array.from(
        { length: 100 },
        (_, i) =>
          `<record id="${i}"><name>Record ${i}</name><value>${Math.random()}</value><active>${i % 2 === 0}</active></record>`
      ).join("")}</data>`;

      const schema = z.toJSONSchema(
        z.object({
          data: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              value: z.number(),
              active: z.boolean(),
            })
          ),
        })
      );

      const startTime = Date.now();
      const result = RXML.parse(mediumXml, schema);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
      const data = (
        result as unknown as { data: Array<{ value: number; active: boolean }> }
      ).data;
      expect(data).toHaveLength(100);
      expect(typeof data[0].value).toBe("number");
      expect(typeof data[0].active).toBe("boolean");
    });
  });

  describe("TXML feature compatibility", () => {
    it("supports CDATA sections like TXML", () => {
      const xml = `<xml><![CDATA[some data]]></xml>`;
      const result = RXML.parseWithoutSchema(xml);
      const xmlNode = result[0] as any;
      expect(xmlNode.children[0]).toBe("some data");
    });

    it("supports comments when enabled", () => {
      const xml = `<test><!-- test --></test>`;
      const result = RXML.parseWithoutSchema(xml, { keepComments: true });
      const testNode = result[0] as any;
      expect(testNode.children).toContain("<!-- test -->");
    });

    it("supports processing instructions", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><root></root>`;
      const result = RXML.parseWithoutSchema(xml);
      expect(result[0]).toMatchObject({
        tagName: "?xml",
        attributes: {
          version: "1.0",
          encoding: "UTF-8",
        },
      });
    });

    it("supports simplify functionality", () => {
      const xml = `<test><cc>one</cc>test<cc f="test"><sub>3</sub>two</cc><dd></dd></test>`;
      const parsed = RXML.parseWithoutSchema(xml);
      const simplified = RXML.simplify(parsed);

      expect(simplified).toMatchObject({
        test: {
          cc: ["one", { sub: "3", _attributes: { f: "test" } }],
          dd: "",
        },
      });
    });

    it("supports filter functionality", () => {
      const xml = `<test><cc></cc><cc></cc></test>`;
      const parsed = RXML.parseWithoutSchema(xml);
      const filtered = RXML.filter(
        parsed,
        element => element.tagName.toLowerCase() === "cc"
      );

      expect(filtered).toHaveLength(2);
      expect(filtered[0].tagName).toBe("cc");
      expect(filtered[1].tagName).toBe("cc");
    });
  });
});
