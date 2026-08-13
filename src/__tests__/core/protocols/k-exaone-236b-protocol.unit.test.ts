import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { kExaone236BProtocol } from "../../../core/protocols/k-exaone-236b-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../test-helpers";

const tools = [
  {
    type: "function",
    name: "lookup_shipment",
    description: "Look up one shipment.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        trackingNumber: { type: "string" },
      },
    },
  },
] satisfies LanguageModelV4FunctionTool[];

function runStream(
  chunks: string[],
  streamTools: LanguageModelV4FunctionTool[] = tools
): Promise<LanguageModelV4StreamPart[]> {
  const protocol = kExaone236BProtocol();
  const transformer = protocol.createStreamParser({
    tools: streamTools,
    options: {},
  });
  return convertReadableStreamToArray(
    pipeWithTransformer(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: chunk,
            });
          }
          controller.enqueue({
            type: "finish",
            usage: zeroUsage,
            finishReason: stopFinishReason,
          });
          controller.close();
        },
      }),
      transformer
    )
  );
}

describe("kExaone236BProtocol", () => {
  it("parses the official JSON-in-XML tool call", () => {
    const content = kExaone236BProtocol().parseGeneratedText({
      text: `<tool_call>{"name":"lookup_shipment","arguments":{"trackingNumber":"TRK-77"}}</tool_call>`,
      tools,
    });

    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "lookup_shipment",
        input: '{"trackingNumber":"TRK-77"}',
      })
    );
  });

  it("preserves numeric argument lexemes in generated and streamed calls", async () => {
    const numericTools = [
      {
        type: "function",
        name: "record_numbers",
        inputSchema: {
          type: "object",
          properties: {
            unsafeInteger: { type: "integer" },
            decimal: { type: "number" },
            negativeZero: { type: "number" },
            exponent: { type: "number" },
          },
          additionalProperties: false,
        },
      },
    ] satisfies LanguageModelV4FunctionTool[];
    const call =
      '<tool_call>{"name":"record_numbers","arguments":{"unsafeInteger":9007199254740993,"decimal":1.0,"negativeZero":-0.0,"exponent":1e-07,"ignored":9.0}}</tool_call>';
    const expectedInput =
      '{"unsafeInteger":9007199254740993,"decimal":1.0,"negativeZero":-0.0,"exponent":1e-07}';

    const generated = kExaone236BProtocol().parseGeneratedText({
      text: call,
      tools: numericTools,
    });
    const streamed = await runStream([call], numericTools);

    expect(generated).toMatchObject([
      { type: "tool-call", input: expectedInput },
    ]);
    expect(streamed).toContainEqual(
      expect.objectContaining({ type: "tool-call", input: expectedInput })
    );
  });

  it("preserves supported parameters aliases during recovery", () => {
    const aliasTools = [
      {
        type: "function",
        name: "record_numbers",
        inputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ] satisfies LanguageModelV4FunctionTool[];
    const content = kExaone236BProtocol().parseGeneratedText({
      text: '<tool_call>{"name":"record_numbers","parameters":{"value":9007199254740993}}</tool_call>',
      tools: aliasTools,
    });

    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "record_numbers",
        input: '{"value":9007199254740993}',
      })
    );
  });

  it("preserves a nested argument named parameters", () => {
    const nestedTools = [
      {
        type: "function",
        name: "configure",
        inputSchema: {
          type: "object",
          properties: {
            parameters: {
              type: "object",
              properties: { value: { type: "integer" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          required: ["parameters"],
          additionalProperties: false,
        },
      },
    ] satisfies LanguageModelV4FunctionTool[];

    const content = kExaone236BProtocol().parseGeneratedText({
      text: '<tool_call>{"name":"configure","arguments":{"parameters":{"value":9007199254740993}}}</tool_call>',
      tools: nestedTools,
    });

    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "configure",
        input: '{"parameters":{"value":9007199254740993}}',
      })
    );
  });

  it("preserves escaped quotes in single-quoted relaxed JSON", () => {
    const quotedTools = [
      {
        type: "function",
        name: "record",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "integer" },
            label: { type: "string" },
          },
          required: ["value", "label"],
          additionalProperties: false,
        },
      },
    ] satisfies LanguageModelV4FunctionTool[];

    const content = kExaone236BProtocol().parseGeneratedText({
      text: `<tool_call>{'name':'record','arguments':{'value':9007199254740993,'label':'O\\'Brien said "hi"'}}}</tool_call>`,
      tools: quotedTools,
    });

    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        input: `{"value":9007199254740993,"label":"O'Brien said \\"hi\\""}`,
      })
    );
  });

  it.each([
    [
      "relaxed JSON",
      `{'name':'record_numbers','arguments':{'unsafeInteger':9007199254740993,'decimal':1.0,'label':"O'Brien",}}`,
      `{"unsafeInteger":9007199254740993,"decimal":1.0,"label":"O'Brien"}`,
    ],
    [
      "strict key normalization",
      '{"name":"record_numbers","arguments":{"user_id":9007199254740993}}',
      '{"userId":9007199254740993}',
    ],
  ])("preserves numeric lexemes through %s", (_name, body, expectedInput) => {
    const numericTools = [
      {
        type: "function",
        name: "record_numbers",
        inputSchema: {
          type: "object",
          properties: {
            unsafeInteger: { type: "integer" },
            decimal: { type: "number" },
            userId: { type: "integer" },
            label: { type: "string" },
          },
          required: expectedInput.includes("userId") ? ["userId"] : undefined,
          additionalProperties: false,
        },
      },
    ] satisfies LanguageModelV4FunctionTool[];

    const content = kExaone236BProtocol().parseGeneratedText({
      text: `<tool_call>${body}</tool_call>`,
      tools: numericTools,
    });

    expect(content).toContainEqual(
      expect.objectContaining({ type: "tool-call", input: expectedInput })
    );
  });

  it.each([
    [
      "nested-start recovery",
      '<tool_call>{"name":"record_numbers","arguments":{"unsafeInteger":9007199254740993,"decimal":1.0,"negativeZero":-0.0,"exponent":1e-07}}\n<tool_call>{"name":"record_numbers","arguments":{"unsafeInteger":9007199254740993,"decimal":1.0,"negativeZero":-0.0,"exponent":1e-07}}</tool_call>',
    ],
    [
      "finish salvage",
      '<tool_call>{"name":"record_numbers","arguments":{"unsafeInteger":9007199254740993,"decimal":1.0,"negativeZero":-0.0,"exponent":1e-07}}',
    ],
  ])("preserves numeric lexemes through %s", async (name, text) => {
    const numericTools = [
      {
        type: "function",
        name: "record_numbers",
        inputSchema: {
          type: "object",
          properties: {
            unsafeInteger: { type: "integer" },
            decimal: { type: "number" },
            negativeZero: { type: "number" },
            exponent: { type: "number" },
          },
        },
      },
    ] satisfies LanguageModelV4FunctionTool[];
    const expectedInput =
      '{"unsafeInteger":9007199254740993,"decimal":1.0,"negativeZero":-0.0,"exponent":1e-07}';

    const streamed = await runStream([text], numericTools);
    const calls = streamed.filter((part) => part.type === "tool-call");

    expect(calls).toHaveLength(name === "nested-start recovery" ? 2 : 1);
    expect(calls.every((call) => call.input === expectedInput)).toBe(true);
  });

  it("formats history calls with native spacing and lossless number lexemes", () => {
    const protocol = kExaone236BProtocol();

    expect(
      protocol.formatToolCall?.({
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup_shipment",
        input: '{"orderId":"O-77","scores":[9007199254740993,1.0,-0.0]}',
      })
    ).toBe(
      '<tool_call>{"name": "lookup_shipment", "arguments": {"orderId": "O-77", "scores": [9007199254740993, 1.0, -0.0]}}</tool_call>'
    );
  });

  it("leaves non-Hermes argument-tag output as text", () => {
    const text = `<tool_call>lookup_shipment
<arg_key>trackingNumber</arg_key>
<arg_value>TRK-77</arg_value>
</tool_call>`;

    const content = kExaone236BProtocol().parseGeneratedText({ text, tools });

    expect(content).toEqual([{ type: "text", text }]);
  });

  it("does not emit streamed calls for non-Hermes argument tags", async () => {
    const content = await runStream([
      "<tool_call>lookup_shipment\n<arg_key>tracking",
      "Number</arg_key>\n<arg_value>TRK-77</arg_value>\n</tool_call>",
    ]);

    expect(content).not.toContainEqual(
      expect.objectContaining({ type: "tool-call" })
    );
  });
});
