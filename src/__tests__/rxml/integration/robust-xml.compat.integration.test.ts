import { describe, expect, it } from "vitest";

import { stringify as rxmlStringify } from "../../../rxml/builders/stringify";
import { RXMLDuplicateStringTagError } from "../../../rxml/errors/types";
import { parse as rxmlParse } from "../../../rxml/parse";

const VALUE_100 = 100;

describe("RXML compat", () => {
  describe("parse: basic and options", () => {
    it("parses simple string field", () => {
      const xml = "<location>San Francisco</location>";
      const schema = {
        type: "object",
        properties: { location: { type: "string" } },
        additionalProperties: false,
      };
      const out = rxmlParse(xml, schema);
      expect(out).toEqual({ location: "San Francisco" });
    });

    it("supports custom textNodeName for unwrapping", () => {
      const xml = `<value kind="n"> 10.5 </value>`;
      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
        additionalProperties: false,
      };
      // Use a non-default text node name and ensure we still unwrap
      const out = rxmlParse(xml, schema, { textNodeName: "_text" });
      // Coercion to number expected
      expect(out).toEqual({ value: 10.5 });
    });
  });

  describe("parse: heuristics", () => {
    it("normalizes <item> lists to arrays of numbers", () => {
      const xml =
        "<numbers><item> 1 </item><item>2</item><item>1e2</item></numbers>";
      const schema = {
        type: "object",
        properties: {
          numbers: { type: "array", items: { type: "number" } },
        },
        additionalProperties: false,
      };
      const out = rxmlParse(xml, schema);
      expect(out).toEqual({ numbers: [1, 2, VALUE_100] });
    });

    it("handles arrays of string elements and trims text content", () => {
      const xml = "<tags><item> a </item><item>b</item><item> c </item></tags>";
      const schema = {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      };
      const out = rxmlParse(xml, schema);
      expect(out).toEqual({ tags: ["a", "b", "c"] });
    });

    it("keeps nested element structure; text is under #text key", () => {
      const xml = `<obj><name attr="x"> John Doe </name></obj>`;
      const schema = {
        type: "object",
        properties: {
          obj: {
            type: "object",
            properties: { name: { type: "string" } },
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      };
      const out = rxmlParse(xml, schema);
      expect(out).toEqual({
        obj: { name: { "#text": "John Doe", "@_attr": "x" } },
      });
    });
  });

  describe("parse: duplicate string tag handling", () => {
    it("throws RXMLDuplicateStringTagError for duplicate string tags (default)", () => {
      const xml = "<content>A</content><content>B</content>";
      const schema = {
        type: "object",
        properties: { content: { type: "string" } },
        additionalProperties: false,
      };
      expect(() => rxmlParse(xml, schema)).toThrowError(
        RXMLDuplicateStringTagError
      );
    });
  });

  describe("stringify", () => {
    it("builds XML with given root tag and preserves structure", () => {
      const xml = rxmlStringify("tool_response", {
        tool_name: "get_weather",
        result: { ok: true },
      });
      expect(xml).toContain("<tool_response>");
      expect(xml).toContain("<tool_name>get_weather</tool_name>");
      expect(xml).toContain("<result>");
    });
  });
});
