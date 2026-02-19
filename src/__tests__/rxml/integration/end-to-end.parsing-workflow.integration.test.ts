import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseWithoutSchema } from "../../../rxml/core/parser";
import { RXMLDuplicateStringTagError } from "../../../rxml/errors/types";
import { parse } from "../../../rxml/parse";

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

      const result = parse(xml, schema);
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

      expect(() => {
        const result = parseWithoutSchema(malformedXml);
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

      const result = parse(xml, schema);
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

      expect(() => parse(xml, schema)).toThrow(RXMLDuplicateStringTagError);

      const result = parse(xml, schema, {
        throwOnDuplicateStringTags: false,
      });
      expect(result.description).toBe("First description");
      expect(result.value).toBe(100);
    });
  });
});
