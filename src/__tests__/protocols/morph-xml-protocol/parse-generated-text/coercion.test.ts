import type { JSONValue, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { ToolInputSchema } from "../../../../schema/tool-input-schema";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

type MorphTool = Omit<LanguageModelV4FunctionTool, "inputSchema"> & {
  readonly inputSchema: ToolInputSchema;
};

interface CoercionCase {
  readonly description?: string;
  readonly expected: JSONValue;
  readonly expectedToolName?: string;
  readonly name: string;
  readonly schema: ToolInputSchema;
  readonly text: string;
  readonly toolName: string;
}

const cases: readonly CoercionCase[] = [
  {
    name: "coerces string numbers/booleans to primitives using simple object schema",
    toolName: "calc",
    schema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "integer" },
        c: { type: "boolean" },
        d: { type: "string" },
      },
    },
    text: "<calc><a>10</a><b>5</b><c>true</c><d>ok</d></calc>",
    expected: { a: 10, b: 5, c: true, d: "ok" },
  },
  {
    name: "coerces using jsonSchema-wrapped schema",
    toolName: "calc",
    schema: {
      jsonSchema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "boolean" } },
      },
    },
    text: "<calc><x>3.14</x><y>false</y></calc>",
    expected: { x: 3.14, y: false },
  },
  {
    name: "applies heuristic coercion when schema missing but values are numeric/boolean strings",
    toolName: "calc",
    schema: { type: "object" },
    text: "<calc><n>42</n><t>true</t><s>hello</s></calc>",
    expected: { n: 42, t: true, s: "hello" },
  },
  {
    name: "coerces array from JSON string and CSV/newline to number[]",
    toolName: "calc",
    schema: {
      type: "object",
      properties: {
        coords: { type: "array", items: { type: "number" } },
        a1: { type: "array", items: { type: "number" } },
        a2: { type: "array", items: { type: "number" } },
      },
    },
    text: "<calc><coords>[3,4,5]</coords><a1>1, 2, 3</a1><a2>10\n20\n30</a2></calc>",
    expected: { coords: [3, 4, 5], a1: [1, 2, 3], a2: [10, 20, 30] },
  },
  {
    name: "coerces array from XML item shape to typed array",
    toolName: "player",
    schema: {
      type: "object",
      properties: {
        stats_fields: { type: "array", items: { type: "string" } },
        nums: { type: "array", items: { type: "number" } },
      },
    },
    text: "<player><stats_fields>['points', 'assists']</stats_fields><nums>[1, 2, 3]</nums></player>",
    expected: { stats_fields: ["points", "assists"], nums: [1, 2, 3] },
  },
  {
    name: "coerces object from JSON-like string (single quotes) and nested objects",
    toolName: "realestate",
    schema: {
      type: "object",
      properties: {
        budget: {
          type: "object",
          properties: { min: { type: "number" }, max: { type: "number" } },
        },
        gradeDict: {
          type: "object",
          properties: {
            math: { type: "number" },
            science: { type: "number" },
          },
        },
      },
    },
    text: "<realestate><budget>{'min':300000,'max':400000}</budget><gradeDict>{'math':90,'science':75}</gradeDict></realestate>",
    expected: {
      budget: { min: 300_000, max: 400_000 },
      gradeDict: { math: 90, science: 75 },
    },
  },
  {
    name: "recursively coerces nested arrays of objects",
    toolName: "nested",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "boolean" } },
          },
        },
      },
    },
    text: "<nested><items>[{'a':1,'b':true},{'a':2,'b':false}]</items></nested>",
    expected: {
      items: [
        { a: 1, b: true },
        { a: 2, b: false },
      ],
    },
  },
  {
    name: "handles booleans (case-insensitive) and numbers with scientific notation",
    toolName: "calc",
    schema: {
      type: "object",
      properties: {
        t: { type: "boolean" },
        f: { type: "boolean" },
        n: { type: "number" },
      },
    },
    text: "<calc><t>TRUE</t><f>false</f><n>1.23e3</n></calc>",
    expected: { t: true, f: false, n: 1230 },
  },
  {
    name: "preserves strings when schema says string even if numeric-like",
    toolName: "s",
    schema: { type: "object", properties: { s: { type: "string" } } },
    text: "<s><s>10</s></s>",
    expected: { s: "10" },
  },
  {
    name: "handles empty array/object inputs",
    toolName: "empty",
    schema: {
      type: "object",
      properties: {
        arr: { type: "array", items: { type: "number" } },
        obj: { type: "object", properties: { a: { type: "number" } } },
      },
    },
    text: "<empty><arr>   </arr><obj>{}</obj></empty>",
    expected: { arr: [], obj: {} },
  },
  {
    name: "preserves wrapper key for unconstrained array items",
    toolName: "wrap",
    schema: {
      type: "object",
      properties: { arr: { type: "array", items: {} } },
    },
    text: "<wrap><arr><user><name>A</name></user></arr></wrap>",
    expected: { arr: [{ user: { name: "A" } }] },
  },
  {
    name: "coerces array items when item-wrapped contains object strings",
    toolName: "wrap",
    schema: {
      type: "object",
      properties: {
        arr: {
          type: "array",
          items: {
            type: "object",
            properties: { min: { type: "number" } },
          },
        },
      },
    },
    text: "<wrap><arr><item>{'min':1}</item><item>{'min':2}</item></arr></wrap>",
    expected: { arr: [{ min: 1 }, { min: 2 }] },
  },
  {
    name: "handles multiline JSON strings in object properties",
    toolName: "calculate_average",
    description: "Calculate average grade",
    schema: {
      type: "object",
      properties: {
        gradeDict: {
          type: "object",
          description:
            "A dictionary where keys represent subjects and values represent scores",
        },
      },
      required: ["gradeDict"],
    },
    text: `<calculate_average><gradeDict>{\n  "math": 90,\n  "science": 75,\n  "history": 82,\n  "music": 89\n}</gradeDict></calculate_average>`,
    expectedToolName: "calculate_average",
    expected: {
      gradeDict: { math: 90, science: 75, history: 82, music: 89 },
    },
  },
];

vi.spyOn(console, "warn").mockImplementation(() => {
  // Intentionally empty - suppress console warnings during tests
});

function parseCoercionCase(testCase: CoercionCase) {
  const tool: MorphTool = {
    type: "function",
    name: testCase.toolName,
    description: testCase.description ?? "",
    inputSchema: testCase.schema,
  };
  const output = runGeneratedJsonRepair({
    protocol: morphXmlProtocol(),
    text: testCase.text,
    tools: [tool],
  });
  const toolCall = output.find((part) => part.type === "tool-call");
  expect(toolCall).toBeTruthy();
  if (toolCall?.type !== "tool-call") {
    throw new TypeError("Expected tool-call part");
  }
  return toolCall;
}

describe("morphXmlProtocol parseGeneratedText coercion", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const toolCall = parseCoercionCase(testCase);
      if (testCase.expectedToolName !== undefined) {
        expect(toolCall.toolName).toBe(testCase.expectedToolName);
      }
      const parsed: JSONValue = JSON.parse(toolCall.input);
      expect(parsed).toEqual(testCase.expected);
    });
  }
});
