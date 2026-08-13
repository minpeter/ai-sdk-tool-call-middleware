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

const richTools = [
  {
    type: "function",
    name: "lookup_shipment",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            routes: { type: "array", items: { type: "string" } },
            fragile: { type: "boolean" },
          },
        },
        note: { type: "string" },
      },
    },
  },
] satisfies LanguageModelV4FunctionTool[];

function runStream(chunks: string[]): Promise<LanguageModelV4StreamPart[]> {
  const protocol = kExaone236BProtocol();
  const transformer = protocol.createStreamParser({
    tools,
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

  it("parses two adjacent calls and preserves surrounding text", () => {
    const content = kExaone236BProtocol().parseGeneratedText({
      text: `Checking both identifiers.
<tool_call>{"name":"lookup_shipment","arguments":{"orderId":"O-1"}}</tool_call>
<tool_call>{"name":"lookup_shipment","arguments":{"trackingNumber":"TRK-2"}}</tool_call>
Done.`,
      tools,
    });

    expect(content.filter((part) => part.type === "tool-call")).toEqual([
      expect.objectContaining({
        toolName: "lookup_shipment",
        input: '{"orderId":"O-1"}',
      }),
      expect.objectContaining({
        toolName: "lookup_shipment",
        input: '{"trackingNumber":"TRK-2"}',
      }),
    ]);
    expect(content.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "Checking both identifiers.\n" },
      { type: "text", text: "\nDone." },
    ]);
  });

  it("parses Unicode, nested values, and escaped strings", () => {
    const content = kExaone236BProtocol().parseGeneratedText({
      text: '<tool_call>{"name":"lookup_shipment","arguments":{"orderId":"서울-\\"A\\"","metadata":{"routes":["인천","부산"],"fragile":true},"note":"line1\\nline2"}}</tool_call>',
      tools: richTools,
    });

    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "lookup_shipment",
        input:
          '{"orderId":"서울-\\"A\\"","metadata":{"routes":["인천","부산"],"fragile":true},"note":"line1\\nline2"}',
      })
    );
  });

  it("recovers a trailing comma in malformed Hermes JSON", () => {
    const text =
      '<tool_call>{"name":"lookup_shipment","arguments":{"orderId":"O-1",}}</tool_call>';

    const content = kExaone236BProtocol().parseGeneratedText({ text, tools });

    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "lookup_shipment",
        input: '{"orderId":"O-1"}',
      })
    );
  });

  it("reassembles a valid call split across syntax boundaries", async () => {
    const content = await runStream([
      "<tool",
      "_call>",
      '{"na',
      'me":"lookup_',
      'shipment","arg',
      'uments":{"tracking',
      'Number":"TRK-',
      '99"}}',
      "</tool_",
      "call>",
    ]);

    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "lookup_shipment",
        input: '{"trackingNumber":"TRK-99"}',
      })
    );
  });
});
