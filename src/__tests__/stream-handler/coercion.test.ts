import type {
  JSONSchema7Definition,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { uiTarsXmlProtocol } from "../../core/protocols/compat-aliases";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";
import {
  createChunkedStream,
  mockFinishReason,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

const passthroughProtocol: TCMCoreProtocol = {
  createStreamParser: () => new TransformStream(),
  parseGeneratedText: () => [],
  formatToolCall: () => "",
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
};

function functionTool(
  name: string,
  properties: Record<string, JSONSchema7Definition>,
  required?: string[]
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: { type: "object", properties, required },
  };
}

function wrapSource(
  protocol: TCMCoreProtocol,
  tools: LanguageModelV4FunctionTool[],
  stream: ReadableStream<LanguageModelV4StreamPart>
) {
  return wrapStream({
    protocol,
    doStream: vi.fn().mockResolvedValue({ stream }),
    doGenerate: vi.fn(),
    params: {
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
  });
}

async function runChunks(
  protocol: TCMCoreProtocol,
  tools: LanguageModelV4FunctionTool[],
  chunks: string[],
  id: string
): Promise<LanguageModelV4StreamPart[]> {
  const result = await wrapSource(
    protocol,
    tools,
    createChunkedStream(chunks, id)
  );
  return convertReadableStreamToArray(result.stream);
}

function timeline(parts: readonly LanguageModelV4StreamPart[]) {
  const deltas = parts.filter(
    (
      part
    ): part is Extract<
      LanguageModelV4StreamPart,
      { type: "tool-input-delta" }
    > => part.type === "tool-input-delta"
  );
  return {
    deltas,
    joined: deltas.map((part) => part.delta).join(""),
    endIndex: parts.findIndex((part) => part.type === "tool-input-end"),
    startIndex: parts.findIndex((part) => part.type === "tool-input-start"),
    toolCall: parts.find(
      (
        part
      ): part is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call"
    ),
    toolCallIndex: parts.findIndex((part) => part.type === "tool-call"),
  };
}

function createGate() {
  let release = (): void => {
    throw new Error("Gate was not initialized");
  };
  const wait = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { release, wait };
}

async function drain(
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return parts;
    }
    parts.push(next.value);
  }
}

async function releaseAfterStart(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  release: () => void
): Promise<LanguageModelV4StreamPart[]> {
  const reader = stream.getReader();
  const first = await reader.read();
  expect(first.value?.type).toBe("tool-input-start");
  release();
  const remaining = await drain(reader);
  return first.value ? [first.value, ...remaining] : remaining;
}

const calcTool = functionTool(
  "calc",
  { a: { type: "number" }, b: { type: "boolean" } },
  ["a", "b"]
);

const crossProtocolCases: readonly {
  readonly name: string;
  readonly protocol: TCMCoreProtocol;
  readonly chunks: string[];
}[] = [
  {
    name: "hermes",
    protocol: hermesProtocol(),
    chunks: [
      '<tool_call>{"name":"calc","arg',
      'uments":{"a":"10","b":"false"}}</tool_call>',
    ],
  },
  {
    name: "morph-xml",
    protocol: morphXmlProtocol(),
    chunks: ["<calc>\n<a>10</a>\n<b>false</b>\n</calc>"],
  },
  {
    name: "yaml-xml",
    protocol: yamlXmlProtocol(),
    chunks: ['<calc>\na: "10"\nb: "false"\n</calc>'],
  },
  {
    name: "qwen3coder",
    protocol: qwen3CoderProtocol(),
    chunks: [
      "<tool_call><function=calc><parameter=a>10</parameter><parameter=b>false</parameter></function></tool_call>",
    ],
  },
  {
    name: "ui-tars-xml",
    protocol: uiTarsXmlProtocol(),
    chunks: [
      "<tool_call><function=calc><parameter=a>10</parameter><parameter=b>false</parameter></function></tool_call>",
    ],
  },
];

describe("wrapStream tool-call coercion", () => {
  it("coerces streamed tool-call input using originalTools schema", async () => {
    const source = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "tool-call",
          toolCallId: "id",
          toolName: "calc",
          input: '{"a":"10","b":"false"}',
        });
        controller.enqueue({
          type: "finish",
          finishReason: mockFinishReason("tool-calls"),
          usage: zeroUsage,
        });
        controller.close();
      },
    });
    const result = await wrapSource(passthroughProtocol, [calcTool], source);
    const parts = await convertReadableStreamToArray(result.stream);
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: '{"a":10,"b":false}',
    });
  });

  it("emits tool-input-delta while streaming tool-call arguments", async () => {
    const weather = functionTool(
      "get_weather",
      { location: { type: "string" }, unit: { type: "string" } },
      ["location"]
    );
    const parts = await runChunks(
      hermesProtocol(),
      [weather],
      [
        '<tool_call>{"name":"get_weather","arg',
        'uments":{"location":"Seoul","unit":"celsius"}}</tool_call>',
      ],
      "seed"
    );
    const observed = timeline(parts);
    expect(observed.startIndex).toBeGreaterThanOrEqual(0);
    expect(observed.deltas[0]).toBeDefined();
    expect(observed.endIndex).toBeGreaterThan(observed.startIndex);
    expect(observed.toolCallIndex).toBeGreaterThan(observed.endIndex);
    expect(observed.joined).toBe(observed.toolCall?.input);
  });

  for (const scenario of crossProtocolCases) {
    it(`${scenario.name} keeps streamed tool-input-delta aligned with final coerced tool-call input`, async () => {
      const parts = await runChunks(
        scenario.protocol,
        [calcTool],
        scenario.chunks,
        `seed-${scenario.name}`
      );
      const observed = timeline(parts);
      expect(observed.startIndex).toBeGreaterThanOrEqual(0);
      expect(observed.endIndex).toBeGreaterThanOrEqual(0);
      expect(observed.joined).toBe(observed.toolCall?.input);
      expect(JSON.parse(observed.joined)).toEqual({ a: 10, b: false });
    });
  }

  it("holds qwen tool-input-delta until delayed final chunk is validated", async () => {
    const gate = createGate();
    const source = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "seed-streaming",
          delta: "<tool_call><function=calc><parameter=a>10</parameter>",
        });
        await gate.wait;
        controller.enqueue({
          type: "text-delta",
          id: "seed-streaming",
          delta: "<parameter=b>false</parameter></function></tool_call>",
        });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        controller.close();
      },
    });
    const result = await wrapSource(qwen3CoderProtocol(), [calcTool], source);
    const parts = await releaseAfterStart(result.stream, gate.release);
    const observed = timeline(parts);
    expect(observed.deltas.length).toBeGreaterThanOrEqual(2);
    expect(observed.endIndex).toBeGreaterThan(observed.startIndex);
    expect(observed.toolCallIndex).toBeGreaterThan(observed.endIndex);
    expect(observed.deltas[0]?.delta.length).toBeLessThan(
      observed.joined.length
    );
    expect(observed.joined.startsWith(observed.deltas[0]?.delta ?? "")).toBe(
      true
    );
    expect(observed.joined).toBe(observed.toolCall?.input);
  });

  it("holds qwen long single content deltas until close while keeping coercion", async () => {
    const markdownTool = functionTool(
      "write_markdown_file",
      {
        file_path: { type: "string" },
        line_count: { type: "integer" },
        content: { type: "string" },
      },
      ["file_path", "line_count", "content"]
    );
    const longContent = "long_content_segment_".repeat(600);
    const splitIndex = Math.floor(longContent.length * 0.7);
    const gate = createGate();
    const source = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "seed-long-content",
          delta:
            "<tool_call><function=write_markdown_file><parameter=file_path>stream-tool-input-visual-demo.md</parameter><parameter=line_count>420</parameter><parameter=content>" +
            longContent.slice(0, splitIndex),
        });
        await gate.wait;
        controller.enqueue({
          type: "text-delta",
          id: "seed-long-content",
          delta: `${longContent.slice(splitIndex)}</parameter></function></tool_call>`,
        });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        controller.close();
      },
    });
    const result = await wrapSource(
      qwen3CoderProtocol(),
      [markdownTool],
      source
    );
    const parts = await releaseAfterStart(result.stream, gate.release);
    const observed = timeline(parts);
    expect(observed.deltas.length).toBeGreaterThanOrEqual(2);
    expect(observed.joined).toBe(observed.toolCall?.input);
    const parsed = JSON.parse(observed.toolCall?.input ?? "{}");
    expect(parsed.file_path).toBe("stream-tool-input-visual-demo.md");
    expect(parsed.line_count).toBe(420);
    expect(parsed.content).toBe(longContent);
  });
});
