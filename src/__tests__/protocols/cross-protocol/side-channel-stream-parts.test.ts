import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { hermesProtocol } from "../../../core/protocols/hermes-protocol";
import { kExaone2Protocol } from "../../../core/protocols/k-exaone-2-protocol";
import { kExaone236BProtocol } from "../../../core/protocols/k-exaone-236b-protocol";
import { morphXmlProtocol } from "../../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../core/protocols/yaml-xml-protocol";
import { originalToolsSchema } from "../../../core/utils/provider-options";
import { wrapStream } from "../../../stream-handler";
import { stopFinishReason, zeroUsage } from "../../test-helpers";

// `raw` (includeRawChunks) and `ping` (keep-alive heartbeat) parts carry no
// generated content. Providers interleave them between the text deltas of a
// single tool call, so they must never act as a content boundary: flushing
// buffered text on one publishes a half-received tool tag as plain text and
// loses the call.

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" }, unit: { type: "string" } },
      required: ["city"],
    },
  },
];

const protocols: Array<{ name: string; protocol: TCMCoreProtocol }> = [
  { name: "hermes", protocol: hermesProtocol() },
  { name: "morph-xml", protocol: morphXmlProtocol() },
  { name: "yaml-xml", protocol: yamlXmlProtocol() },
  { name: "qwen3coder", protocol: qwen3CoderProtocol() },
  { name: "glm5", protocol: glm5Protocol() },
  { name: "k-exaone-2", protocol: kExaone2Protocol() },
  { name: "k-exaone-236b", protocol: kExaone236BProtocol() },
];

const sideChannelParts: LanguageModelV4StreamPart[] = [
  { type: "ping" },
  { type: "raw", rawValue: { choices: [] } },
];

async function runStream(options: {
  protocol: TCMCoreProtocol;
  text: string;
  chunkSize: number;
  interleaved?: LanguageModelV4StreamPart;
}) {
  const { protocol, text, chunkSize, interleaved } = options;
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "provider-text" },
  ];
  for (let index = 0; index < text.length; index += chunkSize) {
    if (interleaved) {
      parts.push(interleaved);
    }
    parts.push({
      type: "text-delta",
      id: "provider-text",
      delta: text.slice(index, index + chunkSize),
    });
  }
  parts.push(
    { type: "text-end", id: "provider-text" },
    { type: "finish", finishReason: stopFinishReason, usage: zeroUsage }
  );

  const { stream } = await wrapStream({
    protocol,
    doGenerate: () => {
      throw new Error("doGenerate must not be called");
    },
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      }),
    params: {
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
  });
  const output = await convertReadableStreamToArray(stream);

  return {
    interleavedCount: interleaved
      ? output.filter((part) => part.type === interleaved.type).length
      : 0,
    sentInterleavedCount: Math.ceil(text.length / chunkSize),
    summary: {
      text: output
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join(""),
      toolCalls: output
        .filter((part) => part.type === "tool-call")
        .map((part) => ({ toolName: part.toolName, input: part.input })),
      toolInput: output
        .filter((part) => part.type === "tool-input-delta")
        .map((part) => part.delta)
        .join(""),
      finish: output.filter((part) => part.type === "finish"),
    },
  };
}

describe("side-channel stream parts do not disturb tool-call parsing", () => {
  for (const { name, protocol } of protocols) {
    const protocolCall = protocol.formatToolCall({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "get_weather",
      input: JSON.stringify({ city: "Seoul", unit: "c" }),
    });
    const scenarios = [
      {
        scenario: "protocol tool call",
        text: `Let me check.\n${protocolCall}\nDone.`,
      },
      {
        scenario: "bare JSON tool call",
        text: '{"name": "get_weather", "arguments": {"city": "Seoul"}}',
      },
    ];

    for (const { scenario, text } of scenarios) {
      for (const interleaved of sideChannelParts) {
        for (const chunkSize of [1, 3, 7]) {
          it(`${name}: ${scenario} survives ${interleaved.type} parts (chunk size ${chunkSize})`, async () => {
            const baseline = await runStream({ protocol, text, chunkSize });
            const result = await runStream({
              protocol,
              text,
              chunkSize,
              interleaved,
            });

            expect(baseline.summary.toolCalls).toHaveLength(1);
            expect(result.summary).toEqual(baseline.summary);
            expect(result.interleavedCount).toBe(result.sentInterleavedCount);
          });
        }
      }
    }
  }
});
