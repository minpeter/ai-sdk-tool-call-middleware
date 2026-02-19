import { describe, expect, it } from "vitest";
import { z } from "zod";

import { stringify } from "../../../rxml/builders/stringify";
import {
  filter,
  parseWithoutSchema,
  simplify,
} from "../../../rxml/core/parser";
import {
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  RXMLStringifyError,
} from "../../../rxml/errors/types";
import { parse } from "../../../rxml/parse";
import {
  countTagOccurrences,
  extractRawInner,
  findFirstTopLevelRange,
} from "../../../rxml/schema/extraction";

describe("robust-xml integration", () => {
  describe("compat with existing code", () => {
    it("maintains API compatibility", () => {
      expect(typeof parse).toBe("function");
      expect(typeof stringify).toBe("function");
      expect(typeof parseWithoutSchema).toBe("function");
      expect(typeof simplify).toBe("function");
      expect(typeof filter).toBe("function");

      expect(RXMLParseError).toBeDefined();
      expect(RXMLDuplicateStringTagError).toBeDefined();
      expect(RXMLCoercionError).toBeDefined();
      expect(RXMLStringifyError).toBeDefined();

      expect(typeof extractRawInner).toBe("function");
      expect(typeof findFirstTopLevelRange).toBe("function");
      expect(typeof countTagOccurrences).toBe("function");
    });

    it("works with the existing test cases", () => {
      const xml = "<location>San Francisco</location>";
      const schema = z.toJSONSchema(
        z.object({
          location: z.string(),
        })
      );
      const result = parse(xml, schema);
      expect(result).toEqual({ location: "San Francisco" });
    });

    it("handles the item list normalization pattern", () => {
      const xml =
        "<numbers><item> 1 </item><item>2</item><item>1e2</item></numbers>";
      const schema = z.toJSONSchema(
        z.object({
          numbers: z.array(z.number()),
        })
      );
      const result = parse(xml, schema);
      expect(result).toEqual({ numbers: [1, 2, 100] });
    });

    it("handles nested element structure with text nodes", () => {
      const xml = `<obj><name attr="x"> John Doe </name></obj>`;
      const schema = z.toJSONSchema(
        z.object({
          obj: z.object({ name: z.string() }).catchall(z.unknown()),
        })
      );
      const result = parse(xml, schema);
      expect(result).toEqual({
        obj: { name: { "#text": "John Doe", "@_attr": "x" } },
      });
    });
  });
});
