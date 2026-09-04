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
} from "../../shared/duplicate-harness";

type OnError = NonNullable<ParserOptions["onError"]>;
type SchemaType = "integer" | "number" | "string";

function schemaTool(inputSchema: JSONSchema7): LanguageModelV4FunctionTool {
  return { type: "function", name: "edit", inputSchema };
}

function payloadBranches(...branches: JSONSchema7[]): JSONSchema7 {
  return {
    type: "object",
    properties: { payload: { oneOf: branches } },
    additionalProperties: false,
  };
}

function valueObject(type: SchemaType): JSONSchema7 {
  return {
    type: "object",
    properties: { value: { type } },
    required: ["value"],
    additionalProperties: false,
  };
}

function streamEdit(
  schema: JSONSchema7,
  argumentsText: string,
  onError: OnError
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    protocol: hermesProtocol(),
    tools: [schemaTool(schema)],
    chunks: [
      `<tool_call>{"name":"edit","arguments":${argumentsText}}</tool_call>`,
    ],
    id: "1",
    parserOptions: { onError },
  });
}

function expectAccepted(
  out: LanguageModelV4StreamPart[],
  expected: JSONValue,
  onError: OnError
): void {
  const tool = out.find((part) => part.type === "tool-call");
  expect(tool?.type).toBe("tool-call");
  expect(JSON.parse(requireToolCall(out).input)).toEqual(expected);
  expect(onError).not.toHaveBeenCalled();
}

function expectRejected(
  out: LanguageModelV4StreamPart[],
  onError: OnError
): void {
  expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
  expect(out.some((part) => part.type === "tool-input-start")).toBe(false);
  expect(out.some((part) => part.type === "tool-input-delta")).toBe(false);
  expect(out.some((part) => part.type === "tool-input-end")).toBe(false);
  expect(onError).toHaveBeenCalled();
}

describe("json-repair.test split 10", () => {
  it("accepts values that match a primitive oneOf branch", async () => {
    const onError = vi.fn<OnError>();
    const out = await streamEdit(
      payloadBranches(
        {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
          additionalProperties: false,
        },
        { type: "string" }
      ),
      '{"payload":"abc"}',
      onError
    );

    expectAccepted(out, { payload: "abc" }, onError);
  });

  it("accepts oneOf object branches distinguished by nested primitive value types", async () => {
    const onError = vi.fn<OnError>();
    const out = await streamEdit(
      payloadBranches(valueObject("string"), valueObject("number")),
      '{"payload":{"value":"abc"}}',
      onError
    );

    expectAccepted(out, { payload: { value: "abc" } }, onError);
  });

  it("does not count numeric strings as numeric oneOf matches", async () => {
    const onError = vi.fn<OnError>();
    const out = await streamEdit(
      payloadBranches(valueObject("string"), valueObject("integer")),
      '{"payload":{"value":"123"}}',
      onError
    );

    expectAccepted(out, { payload: { value: "123" } }, onError);
  });

  it("rejects non-finite numeric strings for number and integer schemas", async () => {
    const cases: readonly (readonly [Exclude<SchemaType, "string">, string])[] =
      [
        ["number", "1e999"],
        ["integer", "9".repeat(400)],
      ];
    for (const [schemaType, value] of cases) {
      const onError = vi.fn<OnError>();
      const out = await streamEdit(
        {
          type: "object",
          properties: { value: { type: schemaType } },
          required: ["value"],
          additionalProperties: false,
        },
        JSON.stringify({ value }),
        onError
      );

      expectRejected(out, onError);
    }
  });

  it("rejects decimal strings for integer oneOf branches", async () => {
    const onError = vi.fn<OnError>();
    const out = await streamEdit(
      payloadBranches(valueObject("integer")),
      '{"payload":{"value":"1.5"}}',
      onError
    );

    expectRejected(out, onError);
  });
});
