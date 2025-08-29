import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";

describe("XML Protocol Heuristic Parsing", () => {
  const protocol = morphXmlProtocol();

  describe("Multiple tags handling", () => {
    it("should convert multiple same-named tags to array", () => {
      const text = `<math_toolkit_sum_of_multiples>
        <lower_limit>1</lower_limit>
        <upper_limit>1000</upper_limit>
        <multiples>3</multiples>
        <multiples>5</multiples>
      </math_toolkit_sum_of_multiples>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "math_toolkit_sum_of_multiples",
          inputSchema: {
            type: "object",
            properties: {
              lower_limit: { type: "number" },
              upper_limit: { type: "number" },
              multiples: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.lower_limit).toBe(1);
        expect(input.upper_limit).toBe(1000);
        expect(input.multiples).toEqual([3, 5]);
      }
    });

    it("should handle multiple tags with text content", () => {
      const text = `<get_cities>
        <country>France</country>
        <city>Paris</city>
        <city>Lyon</city>
        <city>Marseille</city>
      </get_cities>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "get_cities",
          inputSchema: {
            type: "object",
            properties: {
              country: { type: "string" },
              city: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.country).toBe("France");
        expect(input.city).toEqual(["Paris", "Lyon", "Marseille"]);
      }
    });
  });

  describe("Indexed tuple processing", () => {
    it("should convert consecutive indexed tags to array", () => {
      const text = `<set_coordinates>
        <point>
          <0>349</0>
          <1>493</1>
        </point>
      </set_coordinates>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "set_coordinates",
          inputSchema: {
            type: "object",
            properties: {
              point: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.point).toEqual([349, 493]);
      }
    });

    it("should convert three consecutive indexed tags to array", () => {
      const text = `<set_position>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
          <2>15.8</2>
        </coordinates>
      </set_position>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "set_position",
          inputSchema: {
            type: "object",
            properties: {
              coordinates: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.coordinates).toEqual([10.5, 20.3, 15.8]);
      }
    });

    it("should NOT convert non-consecutive indexed tags", () => {
      const text = `<set_data>
        <values>
          <0>first</0>
          <2>third</2>
          <5>sixth</5>
        </values>
      </set_data>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "set_data",
          inputSchema: {
            type: "object",
            properties: {
              values: { type: "object" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values).toEqual({
          "0": "first",
          "2": "third",
          "5": "sixth",
        });
      }
    });

    it("should NOT convert mixed key types", () => {
      const text = `<set_mixed>
        <data>
          <0>zero</0>
          <name>test</name>
        </data>
      </set_mixed>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "set_mixed",
          inputSchema: {
            type: "object",
            properties: {
              data: { type: "object" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.data).toEqual({
          "0": "zero",
          name: "test",
        });
      }
    });
  });

  describe("Internal array structure processing", () => {
    it("should extract array from single key object", () => {
      const text = `<get_numbers>
        <values>
          <number>3</number>
          <number>5</number>
          <number>7</number>
        </values>
      </get_numbers>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "get_numbers",
          inputSchema: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values).toEqual([3, 5, 7]);
      }
    });

    it("should extract string array from single key object", () => {
      const text = `<get_colors>
        <palette>
          <color>red</color>
          <color>green</color>
          <color>blue</color>
        </palette>
      </get_colors>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "get_colors",
          inputSchema: {
            type: "object",
            properties: {
              palette: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type === "tool-call").toBe(true);

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.palette).toEqual(["red", "green", "blue"]);
      }
    });
  });

  describe("Item key pattern processing", () => {
    it("should convert item array to direct array", () => {
      const text = `<weather_get_by_coordinates_date>
        <coordinates>
          <item>46.603354</item>
          <item>1.8883340</item>
        </coordinates>
        <date>2023-12-25</date>
      </weather_get_by_coordinates_date>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "weather_get_by_coordinates_date",
          inputSchema: {
            type: "object",
            properties: {
              coordinates: {
                type: "array",
                items: { type: "number" },
              },
              date: { type: "string" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.coordinates).toEqual([46.603354, 1.888334]); // Note: automatic number conversion and precision
        expect(input.date).toBe("2023-12-25");
      }
    });

    it("should handle single item value", () => {
      const text = `<get_single_value>
        <data>
          <item>42</item>
        </data>
      </get_single_value>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "get_single_value",
          inputSchema: {
            type: "object",
            properties: {
              data: { type: "number" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.data).toBe(42);
      }
    });

    it("should convert string numbers to actual numbers in item arrays", () => {
      const text = `<calculate_distance>
        <point1>
          <item>10.5</item>
          <item>20.3</item>
        </point1>
        <point2>
          <item>15.8</item>
          <item>25.1</item>
        </point2>
      </calculate_distance>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "calculate_distance",
          inputSchema: {
            type: "object",
            properties: {
              point1: {
                type: "array",
                items: { type: "number" },
              },
              point2: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.point1).toEqual([10.5, 20.3]);
        expect(input.point2).toEqual([15.8, 25.1]);
        expect(typeof input.point1[0]).toBe("number");
        expect(typeof input.point2[1]).toBe("number");
      }
    });
  });

  describe("Number conversion accuracy", () => {
    it("should handle floating point precision correctly", () => {
      const text = `<test_precision>
        <values>
          <item>1.2345678900000000</item>
          <item>2.0000000000000001</item>
          <item>3.1415926535897932</item>
        </values>
      </test_precision>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "test_precision",
          inputSchema: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values[0]).toBeCloseTo(1.23456789);
        expect(input.values[1]).toBeCloseTo(2.0);
        expect(input.values[2]).toBeCloseTo(3.141592653589793);
      }
    });

    it("should handle scientific notation", () => {
      const text = `<scientific_values>
        <data>
          <item>1.23e-4</item>
          <item>5.67E+2</item>
          <item>-9.87e-10</item>
        </data>
      </scientific_values>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "scientific_values",
          inputSchema: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.data[0]).toBeCloseTo(0.000123);
        expect(input.data[1]).toBeCloseTo(567);
        expect(input.data[2]).toBeCloseTo(-0.000000000987);
      }
    });
  });

  describe("Edge cases and safety", () => {
    it("should handle text content with #text property", () => {
      const text = `<get_content>
        <message>Hello World</message>
      </get_content>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "get_content",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.message).toBe("Hello World");
      }
    });

    it("should preserve whitespace correctly", () => {
      const text = `<format_text>
        <values>
          <item>  spaced text  </item>
          <item>another  item</item>
        </values>
      </format_text>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "format_text",
          inputSchema: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values).toEqual(["spaced text", "another  item"]);
      }
    });

    it("should not process empty arrays", () => {
      const text = `<empty_data>
        <values></values>
      </empty_data>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "empty_data",
          inputSchema: {
            type: "object",
            properties: {
              values: { type: "string" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values).toBe("");
      }
    });

    it("should handle mixed content types", () => {
      const text = `<mixed_content>
        <data>
          <item>123</item>
          <item>hello</item>
          <item>45.67</item>
          <item>true</item>
        </data>
      </mixed_content>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "mixed_content",
          inputSchema: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { type: "string" }, // Schema expects strings
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        // When schema expects strings but we get numbers, we should still try to convert numbers
        expect(input.data).toEqual([123, "hello", 45.67, "true"]);
      }
    });
  });

  describe("Complex nested structures", () => {
    it("should handle complex nested heuristics", () => {
      const text = `<complex_structure>
        <coordinates>
          <item>46.603354</item>
          <item>1.8883340</item>
        </coordinates>
        <dimensions>
          <0>100</0>
          <1>200</1>
          <2>300</2>
        </dimensions>
        <colors>
          <color>red</color>
          <color>green</color>
          <color>blue</color>
        </colors>
        <name>test</name>
      </complex_structure>`;

      const tools: LanguageModelV2FunctionTool[] = [
        {
          type: "function",
          name: "complex_structure",
          inputSchema: {
            type: "object",
            properties: {
              coordinates: {
                type: "array",
                items: { type: "number" },
              },
              dimensions: {
                type: "array",
                items: { type: "number" },
              },
              colors: {
                type: "array",
                items: { type: "string" },
              },
              name: { type: "string" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.coordinates).toEqual([46.603354, 1.888334]);
        expect(input.dimensions).toEqual([100, 200, 300]);
        expect(input.colors).toEqual(["red", "green", "blue"]);
        expect(input.name).toBe("test");
      }
    });
  });
});
