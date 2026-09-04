import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  requireToolCall,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

type ErrorReporter = NonNullable<ParserOptions["onError"]>;

const contentBranch: JSONSchema7 = {
  type: "object",
  properties: { content: { type: "string" } },
  required: ["content"],
  additionalProperties: false,
};
const primitivePayloadSchema: JSONSchema7 = {
  type: "object",
  properties: { payload: { oneOf: [contentBranch, { type: "string" }] } },
  additionalProperties: false,
};

const constPayloadSchema: JSONSchema7 = {
  type: "object",
  properties: {
    payload: {
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { const: "text" },
            value: { type: "string" },
          },
          required: ["kind", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "count" },
            value: { type: "integer" },
          },
          required: ["kind", "value"],
          additionalProperties: false,
        },
      ],
    },
  },
  additionalProperties: false,
};

function editTool(inputSchema: JSONSchema7): LanguageModelV4FunctionTool {
  return { name: "edit", type: "function", inputSchema };
}

function repairArguments(
  inputSchema: JSONSchema7,
  argumentsText: string,
  onError: ErrorReporter
): Promise<LanguageModelV4StreamPart[]> {
  const text = `<tool_call>{"name":"edit","arguments":${argumentsText}}</tool_call>`;
  return runProtocolTextStream({
    chunks: [text],
    id: "1",
    parserOptions: { onError },
    protocol: hermesProtocol(),
    tools: [editTool(inputSchema)],
  });
}

function assertLifecyclePresent(parts: LanguageModelV4StreamPart[]): void {
  const timeline = selectToolInputTimeline(parts);
  expect(timeline.starts.length > 0).toBe(true);
  expect(timeline.deltas.length > 0).toBe(true);
  expect(timeline.ends.length > 0).toBe(true);
}

function assertParsedCall(
  parts: LanguageModelV4StreamPart[],
  expected: JSONValue,
  onError: ErrorReporter
): void {
  expect(parts.find((part) => part.type === "tool-call")?.type).toBe(
    "tool-call"
  );
  expect(JSON.parse(requireToolCall(parts).input)).toEqual(expected);
  assertLifecyclePresent(parts);
  expect(onError).not.toHaveBeenCalled();
}

function assertQuietCall(
  parts: LanguageModelV4StreamPart[],
  expected: JSONValue,
  onError: ErrorReporter
): void {
  const call = parts.find((part) => part.type === "tool-call");
  expect(call?.type).toBe("tool-call");
  expect(JSON.parse(requireToolCall(parts).input)).toEqual(expected);
  expect(onError).not.toHaveBeenCalled();
}

function assertNoLifecycle(
  parts: LanguageModelV4StreamPart[],
  onError: ErrorReporter
): void {
  const timeline = selectToolInputTimeline(parts);
  expect(parts.find((part) => part.type === "tool-call")).toBeUndefined();
  expect(timeline.starts.length > 0).toBe(false);
  expect(timeline.deltas.length > 0).toBe(false);
  expect(timeline.ends.length > 0).toBe(false);
  expect(onError).toHaveBeenCalled();
}

describe("json-repair.test split 11", () => {
  it("accepts oneOf object branches distinguished by nested enum values", async () => {
    const toolsSchema: JSONSchema7 = {
      type: "object",
      properties: {
        payload: {
          oneOf: ["a", "b"].map((value) => ({
            type: "object",
            properties: { value: { type: "string", enum: [value] } },
            required: ["value"],
            additionalProperties: false,
          })),
        },
      },
      additionalProperties: false,
    };
    for (const value of ["a", "b"]) {
      const onError = vi.fn<ErrorReporter>();
      const out = await repairArguments(
        toolsSchema,
        JSON.stringify({ payload: { value } }),
        onError
      );

      assertParsedCall(out, { payload: { value } }, onError);
    }
  });

  it("accepts oneOf object branches distinguished by nested const values", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["text", '"hello"'],
      ["count", "3"],
    ];
    for (const [kind, value] of cases) {
      const onError = vi.fn<ErrorReporter>();
      const out = await repairArguments(
        constPayloadSchema,
        `{"payload":{"kind":"${kind}","value":${value}}}`,
        onError
      );

      expect(out.find((part) => part.type === "tool-call")?.type).toBe(
        "tool-call"
      );
      assertLifecyclePresent(out);
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("rejects oneOf object branches with mismatched const values", async () => {
    const onError = vi.fn<ErrorReporter>();
    const out = await repairArguments(
      constPayloadSchema,
      '{"payload":{"kind":"count","value":"hello"}}',
      onError
    );

    assertNoLifecycle(out, onError);
  });

  it("drops object keys not declared by primitive oneOf branches", async () => {
    const onError = vi.fn<ErrorReporter>();
    const out = await repairArguments(
      primitivePayloadSchema,
      '{"payload":{"content":"ok","extra":"bad"}}',
      onError
    );

    assertQuietCall(out, { payload: { content: "ok" } }, onError);
  });

  it("drops stray keys before validating top-level anyOf branches", async () => {
    const onError = vi.fn<ErrorReporter>();
    const out = await repairArguments(
      {
        anyOf: [
          {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { latitude: { type: "number" } },
            required: ["latitude"],
            additionalProperties: false,
          },
        ],
      },
      '{"city":"Seoul","stray":"drop"}',
      onError
    );

    assertQuietCall(out, { city: "Seoul" }, onError);
  });
});
