import {
  isJSONObject,
  type JSONObject,
  type JSONSchema7,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

interface EdgeCase {
  readonly assertInput: (input: JSONObject) => void;
  readonly name: string;
  readonly properties: Record<string, JSONSchema7>;
  readonly text: string;
  readonly toolName: string;
}

const cases: readonly EdgeCase[] = [
  {
    name: "should handle text content with #text property",
    toolName: "get_content",
    properties: { message: { type: "string" } },
    text: `<get_content>
        <message>Hello World</message>
      </get_content>`,
    assertInput: (input) => expect(input.message).toBe("Hello World"),
  },
  {
    name: "should preserve whitespace correctly",
    toolName: "format_text",
    properties: {
      values: { type: "array", items: { type: "string" } },
    },
    text: `<format_text>
        <values>
          <item>  spaced text  </item>
          <item>another  item</item>
        </values>
      </format_text>`,
    assertInput: (input) =>
      expect(input.values).toEqual(["spaced text", "another  item"]),
  },
  {
    name: "should not process empty arrays",
    toolName: "empty_data",
    properties: { values: { type: "string" } },
    text: `<empty_data>
        <values></values>
      </empty_data>`,
    assertInput: (input) => expect(input.values).toBe(""),
  },
  {
    name: "should handle mixed content types",
    toolName: "mixed_content",
    properties: { data: { type: "array", items: { type: "string" } } },
    text: `<mixed_content>
        <data>
          <item>123</item>
          <item>hello</item>
          <item>45.67</item>
          <item>true</item>
        </data>
      </mixed_content>`,
    assertInput: (input) =>
      expect(input.data).toEqual(["123", "hello", "45.67", "true"]),
  },
  {
    name: "preserves nested object structure when no #text and no array/tuple heuristics apply (parse mode)",
    toolName: "config",
    properties: { settings: { type: "object" } },
    text: `<config>
        <settings>
          <theme>
            <dark>true</dark>
          </theme>
        </settings>
      </config>`,
    assertInput: (input) => {
      expect(typeof input.settings).toBe("object");
      if (
        !(isJSONObject(input.settings) && isJSONObject(input.settings.theme))
      ) {
        throw new TypeError("Expected nested settings object");
      }
      expect(input.settings.theme.dark).toBe("true");
    },
  },
  {
    name: "maps arrays of objects with #text to trimmed values when prop is array of strings (parse mode)",
    toolName: "tags",
    properties: {
      labels: { type: "array", items: { type: "string" } },
    },
    text: `<tags>
        <labels>
          <item kind="s">  a  </item>
          <item kind="s">b</item>
        </labels>
      </tags>`,
    assertInput: (input) => expect(input.labels).toEqual(["a", "b"]),
  },
];

function edgeInput(testCase: EdgeCase): JSONObject {
  const tool: LanguageModelV4FunctionTool = {
    type: "function",
    name: testCase.toolName,
    inputSchema: { type: "object", properties: testCase.properties },
  };
  const result = runGeneratedJsonRepair({
    protocol: morphXmlProtocol(),
    text: testCase.text,
    tools: [tool],
  });
  expect(result).toHaveLength(1);
  const [first] = result;
  expect(first?.type).toBe("tool-call");
  if (first?.type !== "tool-call") {
    throw new TypeError("Expected one tool-call part");
  }
  const input = JSON.parse(first.input);
  if (!isJSONObject(input)) {
    throw new TypeError("Expected object tool input");
  }
  return input;
}

describe("XML Protocol Heuristic Parsing", () => {
  describe("Edge cases and safety", () => {
    for (const testCase of cases) {
      it(testCase.name, () => {
        testCase.assertInput(edgeInput(testCase));
      });
    }
  });
});
