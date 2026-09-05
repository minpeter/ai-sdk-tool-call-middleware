import type {
  JSONObject,
  JSONSchema7,
  JSONSchema7Definition,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

function repairTool(
  inputSchema: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return { type: "function", name: "edit", inputSchema };
}

type RepairCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function requiredCall(output: LanguageModelV4Content[]): RepairCall {
  const call = output.find(
    (part): part is RepairCall => part.type === "tool-call"
  );
  expect(call?.type).toBe("tool-call");
  if (!call) {
    throw new Error("Tool call was not repaired");
  }
  return call;
}

function strictObject(
  properties: Record<string, JSONSchema7Definition>,
  required: string[]
): JSONSchema7 {
  return { additionalProperties: false, required, properties, type: "object" };
}

function payloadChoice(branches: JSONSchema7[]): JSONSchema7 {
  return {
    additionalProperties: false,
    properties: { payload: { oneOf: branches } },
    type: "object",
  };
}

function topLevelChoice(keyword: "anyOf" | "oneOf"): JSONSchema7 {
  const branches = [
    strictObject({ city: { type: "string" } }, ["city"]),
    strictObject({ latitude: { type: "number" } }, ["latitude"]),
  ];
  return keyword === "anyOf" ? { anyOf: branches } : { oneOf: branches };
}

const enumPayloadSchema = payloadChoice([
  strictObject({ value: { enum: ["a"], type: "string" } }, ["value"]),
  strictObject({ value: { enum: ["b"], type: "string" } }, ["value"]),
]);

const constPayloadSchema = payloadChoice([
  strictObject({ kind: { const: "text" }, value: { type: "string" } }, [
    "kind",
    "value",
  ]),
  strictObject({ kind: { const: "count" }, value: { type: "integer" } }, [
    "kind",
    "value",
  ]),
]);

interface RepairScenario {
  readonly expected?: JSONObject;
  readonly inputSchema: LanguageModelV4FunctionTool["inputSchema"];
  readonly name: string;
  readonly rejects?: boolean;
  readonly text: string;
}

const repairScenarios: readonly RepairScenario[] = [
  {
    name: "rejects decimal strings for integer oneOf branches",
    text: '<tool_call>{"name":"edit","arguments":{"payload":{"value":"1.5"}}}</tool_call>',
    inputSchema: payloadChoice([
      strictObject({ value: { type: "integer" } }, ["value"]),
    ]),
    rejects: true,
  },
  {
    name: "accepts oneOf object branches distinguished by nested enum values",
    text: '<tool_call>{"name":"edit","arguments":{"payload":{"value":"a"}}}</tool_call>',
    inputSchema: enumPayloadSchema,
    expected: { payload: { value: "a" } },
  },
  {
    name: "rejects oneOf object branches with mismatched const values",
    text: '<tool_call>{"name":"edit","arguments":{"payload":{"kind":"count","value":"hello"}}}</tool_call>',
    inputSchema: constPayloadSchema,
    rejects: true,
  },
  {
    name: "drops object keys not declared by primitive oneOf branches",
    text: '<tool_call>{"name":"edit","arguments":{"payload":{"content":"ok","extra":"bad"}}}</tool_call>',
    inputSchema: payloadChoice([
      strictObject({ content: { type: "string" } }, ["content"]),
      { type: "string" },
    ]),
    expected: { payload: { content: "ok" } },
  },
  {
    name: "drops stray keys before validating top-level anyOf branches",
    text: '<tool_call>{"name":"edit","arguments":{"city":"Seoul","stray":"drop"}}</tool_call>',
    inputSchema: topLevelChoice("anyOf"),
    expected: { city: "Seoul" },
  },
  {
    name: "rejects top-level oneOf inputs with keys from multiple strict branches",
    text: '<tool_call>{"name":"edit","arguments":{"city":"Seoul","latitude":37.5}}</tool_call>',
    inputSchema: topLevelChoice("oneOf"),
    rejects: true,
  },
  {
    name: "rejects top-level oneOf inputs with keys from multiple pattern branches",
    text: '<tool_call>{"name":"edit","arguments":{"x-a":"one","y-b":"two"}}</tool_call>',
    inputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          patternProperties: { "^x-": { type: "string" } },
          additionalProperties: false,
        },
        {
          type: "object",
          patternProperties: { "^y-": { type: "string" } },
          additionalProperties: false,
        },
      ],
    },
    rejects: true,
  },
];

describe("json-repair.test split 7", () => {
  for (const scenario of repairScenarios) {
    it(scenario.name, () => {
      const onError = vi.fn();
      const out = runGeneratedJsonRepair({
        protocol: hermesProtocol(),
        text: scenario.text,
        tools: [repairTool(scenario.inputSchema)],
        parserOptions: { onError },
      });
      if (scenario.rejects) {
        expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
        expect(onError).toHaveBeenCalled();
        return;
      }
      const tool = requiredCall(out);
      expect(JSON.parse(tool.input)).toEqual(scenario.expected);
      expect(onError).not.toHaveBeenCalled();
    });
  }

  it("accepts oneOf object branches distinguished by nested const values", () => {
    const tools = [repairTool(constPayloadSchema)];
    for (const [kind, value] of [
      ["text", '"hello"'],
      ["count", "3"],
    ]) {
      const onError = vi.fn();
      const out = runGeneratedJsonRepair({
        protocol: hermesProtocol(),
        text: `<tool_call>{"name":"edit","arguments":{"payload":{"kind":"${kind}","value":${value}}}}</tool_call>`,
        tools,
        parserOptions: { onError },
      });
      const tool = out.find((part) => part.type === "tool-call");
      expect(tool?.type).toBe("tool-call");
      expect(onError).not.toHaveBeenCalled();
    }
  });
});
