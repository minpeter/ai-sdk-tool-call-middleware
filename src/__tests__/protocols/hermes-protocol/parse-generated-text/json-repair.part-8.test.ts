import type {
  JSONObject,
  JSONSchema7Definition,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

function objectTool(
  name: string,
  properties: Record<string, JSONSchema7Definition>
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: { type: "object", properties },
  };
}

function schemaTool(
  name: string,
  inputSchema: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return { type: "function", name, inputSchema };
}

function discriminatedBranch(
  kind: string,
  field: string,
  fieldSchema: JSONSchema7Definition
): LanguageModelV4FunctionTool["inputSchema"] {
  return {
    additionalProperties: false,
    required: ["kind", field],
    properties: { kind: { enum: [kind] }, [field]: fieldSchema },
    type: "object",
  };
}

type ToolCallContent = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function requireRepair(output: LanguageModelV4Content[]): ToolCallContent {
  const result = output.find(
    (part): part is ToolCallContent => part.type === "tool-call"
  );
  expect(result?.type).toBe("tool-call");
  if (!result) {
    throw new Error("Expected repaired tool call");
  }
  return result;
}

interface PatternRepairCase {
  readonly expected?: JSONObject;
  readonly inputSchema: LanguageModelV4FunctionTool["inputSchema"];
  readonly name: string;
  readonly rejects?: boolean;
  readonly text: string;
  readonly toolName: string;
}

const patternRepairCases: readonly PatternRepairCase[] = [
  {
    name: "applies every matching property and pattern schema",
    toolName: "edit",
    text: '<tool_call>{"name":"edit","arguments":{"payload":{"other":"bad"}}}</tool_call>',
    inputSchema: {
      type: "object",
      properties: {
        payload: { type: "object", additionalProperties: true },
      },
      patternProperties: {
        "^payload$": {
          type: "object",
          properties: { must: { type: "string" } },
          required: ["must"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    rejects: true,
  },
  {
    name: "preserves safe additional keys when a denied pattern is unsafe",
    toolName: "write",
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","note":"safe"}}</tool_call>',
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      patternProperties: { "^(a+)+$": false },
      additionalProperties: true,
    },
    expected: { content: "ok", note: "safe" },
  },
  {
    name: "accepts unconstrained unsafe patternProperties when unknown keys are allowed",
    toolName: "write",
    text: '<tool_call>{"name":"write","arguments":{"aaaa":"ok"}}</tool_call>',
    inputSchema: {
      type: "object",
      patternProperties: { "^(a+)+$": {} },
      additionalProperties: true,
    },
    expected: { aaaa: "ok" },
  },
  {
    name: "keeps patternProperties-matching args when unknown keys are allowed even if pattern value coercion fails",
    toolName: "write",
    text: '<tool_call>{"name":"write","arguments":{"x-debug":"not-number","other":"y"}}</tool_call>',
    inputSchema: {
      type: "object",
      patternProperties: { "^x-": { type: "number" } },
      additionalProperties: true,
    },
    expected: { "x-debug": "not-number", other: "y" },
  },
  {
    name: "rejects unsafe positive patternProperties that may match constrained keys",
    toolName: "write",
    text: '<tool_call>{"name":"write","arguments":{"aaaa":123}}</tool_call>',
    inputSchema: {
      type: "object",
      patternProperties: {
        "^(a+)+$": { type: "string", enum: ["allowed"] },
      },
      additionalProperties: true,
    },
    rejects: true,
  },
  {
    name: "drops unsafe false patternProperties that may match key substrings",
    toolName: "write",
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","x-secret":"blocked"}}</tool_call>',
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      patternProperties: { "(secret+)+": false },
      additionalProperties: true,
    },
    expected: { content: "ok" },
  },
  {
    name: "drops unsafe false patternProperties that may match unanchored suffixes",
    toolName: "write",
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","ba":"blocked"}}</tool_call>',
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      patternProperties: { "(a+)+$": false },
      additionalProperties: true,
    },
    expected: { content: "ok" },
  },
  {
    name: "drops keys that may match unsafe false patterns with escaped range endpoints",
    toolName: "write",
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","m":"blocked"}}</tool_call>',
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      patternProperties: { "^([a-\\x7a]+)+$": false },
      additionalProperties: true,
    },
    expected: { content: "ok" },
  },
];

function verifyPatternRepair(scenario: PatternRepairCase): void {
  const onError = vi.fn();
  const out = runGeneratedJsonRepair({
    parserOptions: { onError },
    protocol: hermesProtocol(),
    text: scenario.text,
    tools: [schemaTool(scenario.toolName, scenario.inputSchema)],
  });
  if (scenario.rejects) {
    expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  } else {
    expect(JSON.parse(requireRepair(out).input)).toEqual(scenario.expected);
    expect(onError).not.toHaveBeenCalled();
  }
}

describe("json-repair.test split 8", () => {
  it("selects top-level oneOf branches by discriminator before dropping mixed keys", () => {
    const onError = vi.fn();
    const tools = [
      schemaTool("edit", {
        type: "object",
        oneOf: [
          discriminatedBranch("text", "textOnly", { type: "string" }),
          discriminatedBranch("count", "countOnly", { type: "number" }),
        ],
      }),
    ];
    const out = runGeneratedJsonRepair({
      protocol: hermesProtocol(),
      text: '<tool_call>{"name":"edit","arguments":{"kind":"count","countOnly":3,"textOnly":"drop-me"}}</tool_call>',
      tools,
      parserOptions: { onError },
    });
    const tool = requireRepair(out);
    expect(JSON.parse(tool.input)).toEqual({ kind: "count", countOnly: 3 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not leak incomplete unicode-escaped Hermes candidates from direct parsing", () => {
    const out = runGeneratedJsonRepair({
      protocol: hermesProtocol(),
      text: '<tool_call>{"n\\u0061me":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}',
      tools: [
        objectTool("get_weather", { city: { type: "string" } }),
        objectTool("lookup", { query: { type: "string" } }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("redacts prototype-sensitive error metadata", () => {
    const onError = vi.fn();
    const out = runGeneratedJsonRepair({
      protocol: hermesProtocol(),
      text: '<tool_call>{"name":"write","arguments":{"content":"ok","constructor":{"polluted":true}}}</tool_call>',
      tools: [objectTool("write", { content: { type: "string" } })],
      parserOptions: { onError },
    });
    expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toMatch("[redacted sensitive tool call]");
    for (const secret of ["constructor", "polluted"]) {
      expect(metadataText.includes(secret)).toBe(false);
    }
  });

  for (const scenario of patternRepairCases) {
    it(scenario.name, () => verifyPatternRepair(scenario));
  }
});
