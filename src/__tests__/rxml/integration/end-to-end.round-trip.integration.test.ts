import { describe, expect, it } from "vitest";

import { stringify } from "../../../rxml/builders/stringify";
import { parse } from "../../../rxml/parse";

import { schemaTestCases } from "../fixtures/test-data";

describe("robust-xml integration", () => {
  describe("round-trip processing", () => {
    it("can parse and stringify simple structures", () => {
      const original = {
        tool_name: "get_weather",
        parameters: {
          location: "New York",
          format: "json",
        },
      };

      const xml = stringify("tool_call", original);
      expect(xml).toContain("<tool_call>");
      expect(xml).toContain("<tool_name>get_weather</tool_name>");
      expect(xml).toContain("<location>New York</location>");
      expect(xml).toContain("<format>json</format>");
    });

    it("maintains data types through schema-aware parsing", () => {
      const testCases = Object.values(schemaTestCases);

      for (const testCase of testCases) {
        const result = parse(testCase.xml, testCase.schema);
        expect(result).toEqual(testCase.expected);
      }
    });
  });
});
