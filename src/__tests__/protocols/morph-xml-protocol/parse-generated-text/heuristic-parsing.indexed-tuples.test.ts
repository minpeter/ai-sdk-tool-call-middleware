import {
  isJSONObject,
  type JSONObject,
  type JSONSchema7,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

interface IndexedCase {
  readonly assertInput: (input: JSONObject) => void;
  readonly name: string;
  readonly propertyName: string;
  readonly propertySchema: JSONSchema7;
  readonly text: string;
  readonly toolName: string;
}

const cases: readonly IndexedCase[] = [
  {
    name: "should convert consecutive indexed tags to array",
    toolName: "set_coordinates",
    propertyName: "point",
    propertySchema: { type: "array", items: { type: "number" } },
    text: `<set_coordinates>
        <point>
          <0>349</0>
          <1>493</1>
        </point>
      </set_coordinates>`,
    assertInput: (input) => expect(input.point).toEqual([349, 493]),
  },
  {
    name: "should convert three consecutive indexed tags to array",
    toolName: "set_position",
    propertyName: "coordinates",
    propertySchema: { type: "array", items: { type: "number" } },
    text: `<set_position>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
          <2>15.8</2>
        </coordinates>
      </set_position>`,
    assertInput: (input) =>
      expect(input.coordinates).toEqual([10.5, 20.3, 15.8]),
  },
  {
    name: "should NOT convert non-consecutive indexed tags",
    toolName: "set_data",
    propertyName: "values",
    propertySchema: { type: "object" },
    text: `<set_data>
        <values>
          <0>first</0>
          <2>third</2>
          <5>sixth</5>
        </values>
      </set_data>`,
    assertInput: (input) =>
      expect(input.values).toEqual({
        "0": "first",
        "2": "third",
        "5": "sixth",
      }),
  },
  {
    name: "should NOT convert mixed key types",
    toolName: "set_mixed",
    propertyName: "data",
    propertySchema: { type: "object" },
    text: `<set_mixed>
        <data>
          <0>zero</0>
          <name>test</name>
        </data>
      </set_mixed>`,
    assertInput: (input) =>
      expect(input.data).toEqual({ "0": "zero", name: "test" }),
  },
];

function indexedTool(testCase: IndexedCase): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name: testCase.toolName,
    inputSchema: {
      type: "object",
      properties: { [testCase.propertyName]: testCase.propertySchema },
    },
  };
}

describe("XML Protocol Heuristic Parsing", () => {
  describe("Indexed tuple processing", () => {
    for (const testCase of cases) {
      it(testCase.name, () => {
        const result = morphXmlProtocol().parseGeneratedText({
          text: testCase.text,
          tools: [indexedTool(testCase)],
        });
        expect(result).toHaveLength(1);
        const [first] = result;
        expect(first?.type).toBe("tool-call");
        if (first?.type !== "tool-call") {
          throw new TypeError("Expected indexed tool-call part");
        }
        const input = JSON.parse(first.input);
        if (!isJSONObject(input)) {
          throw new TypeError("Expected indexed object input");
        }
        testCase.assertInput(input);
      });
    }
  });
});
