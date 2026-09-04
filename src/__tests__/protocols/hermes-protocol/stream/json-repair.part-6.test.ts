import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const acceptedPatternCases = [
  {
    name: "accepts unconstrained unsafe patternProperties when unknown keys are allowed",
    schema: {
      type: "object",
      patternProperties: { "^(a+)+$": {} },
      additionalProperties: true,
    },
    text: '<tool_call>{"name":"write","arguments":{"aaaa":"ok"}}</tool_call>',
    input: '{"aaaa":"ok"}',
  },
  {
    name: "keeps patternProperties-matching args when unknown keys are allowed even if pattern value coercion fails",
    schema: {
      type: "object",
      patternProperties: { "^x-": { type: "number" } },
      additionalProperties: true,
    },
    text: '<tool_call>{"name":"write","arguments":{"x-debug":"not-number","other":"y"}}</tool_call>',
    input: '{"x-debug":"not-number","other":"y"}',
  },
] as const satisfies readonly {
  readonly input: string;
  readonly name: string;
  readonly schema: JSONSchema7;
  readonly text: string;
}[];

const blockedArgumentCases = [
  {
    name: "fails closed for unsafe repeated patternProperties without groups",
    toolName: "write",
    schema: {
      type: "object",
      properties: { content: { type: "string" } },
      patternProperties: { "^a+a+$": { type: "string" } },
      additionalProperties: false,
    },
    text: `<tool_call>{"name":"write","arguments":{"content":"ok","${"a".repeat(24)}!":"blocked"}}</tool_call>`,
  },
  {
    name: "rejects prototype-sensitive argument keys without a schema policy",
    toolName: "edit",
    text: '<tool_call>{"name":"edit","arguments":{"constructor":"pollute"}}</tool_call>',
  },
  {
    name: "rejects nested prototype-sensitive argument keys",
    toolName: "edit",
    schema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"edit","arguments":{"payload":{"prototype":"pollute"}}}</tool_call>',
  },
  {
    name: "rejects nested __proto__ argument keys parsed onto prototypes",
    toolName: "edit",
    schema: {
      type: "object",
      properties: {
        payload: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"edit","arguments":{"payload":{"__proto__":{"polluted":true}}}}</tool_call>',
  },
  {
    name: "rejects missing required argument keys",
    toolName: "write",
    schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"write","arguments":{}}</tool_call>',
  },
] as const satisfies readonly {
  readonly name: string;
  readonly schema?: JSONSchema7;
  readonly text: string;
  readonly toolName: string;
}[];

describe("json-repair.test split 6", () => {
  for (const testCase of acceptedPatternCases) {
    it(testCase.name, async () => {
      const onError = vi.fn();
      const result = await runProtocolTextStream({
        chunks: [testCase.text],
        id: "1",
        protocol: hermesProtocol(),
        tools: [
          {
            type: "function",
            name: "write",
            inputSchema: testCase.schema,
          },
        ],
        parserOptions: { onError },
      });

      expect(requireToolCall(result).input).toBe(testCase.input);
      expect(onError).not.toHaveBeenCalled();
    });
  }

  for (const testCase of blockedArgumentCases) {
    it(testCase.name, async () => {
      const onError = vi.fn();
      const tools: LanguageModelV4FunctionTool[] =
        "schema" in testCase
          ? [
              {
                type: "function",
                name: testCase.toolName,
                inputSchema: testCase.schema,
              },
            ]
          : [];
      const result = await runProtocolTextStream({
        chunks: [testCase.text],
        id: "1",
        protocol: hermesProtocol(),
        tools,
        parserOptions: { onError },
      });

      expect(selectToolCalls(result)).toHaveLength(0);
      expect(selectToolInputTimeline(result)).toStrictEqual({
        starts: [],
        deltas: [],
        ends: [],
      });
      expect(onError).toHaveBeenCalled();
    });
  }
});
