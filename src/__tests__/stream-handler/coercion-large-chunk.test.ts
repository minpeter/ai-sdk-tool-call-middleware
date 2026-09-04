import type * as Provider from "@ai-sdk/provider";
import { describe, expect, it, vi as mock } from "vitest";
import {
  Qwen3CoderToolParser,
  uiTarsXmlProtocol,
} from "../../core/protocols/compat-aliases";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";
import {
  createChunkedStream,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

function markdownTool(): Provider.LanguageModelV4FunctionTool {
  return {
    type: "function",
    name: "write_markdown_file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        line_count: { type: "integer" },
        content: { type: "string" },
      },
      required: ["file_path", "line_count", "content"],
    },
  };
}

async function wrappedOutput(
  protocol: TCMCoreProtocol,
  tools: Provider.LanguageModelV4FunctionTool[],
  source: ReadableStream<Provider.LanguageModelV4StreamPart>
) {
  const result = await wrapStream({
    doGenerate: mock.fn(),
    doStream: mock.fn().mockResolvedValue({ stream: source }),
    params: {
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
    protocol,
  });
  return result.stream;
}

function deltaObservation(
  parts: readonly Provider.LanguageModelV4StreamPart[]
) {
  const deltas = parts.filter(
    (
      part
    ): part is Extract<
      Provider.LanguageModelV4StreamPart,
      { type: "tool-input-delta" }
    > => part.type === "tool-input-delta"
  );
  const toolCall = parts.find(
    (
      part
    ): part is Extract<
      Provider.LanguageModelV4StreamPart,
      { type: "tool-call" }
    > => part.type === "tool-call"
  );
  return {
    deltas,
    joined: deltas.map((part) => part.delta).join(""),
    toolCall,
  };
}

async function readThroughDelta(
  reader: ReadableStreamDefaultReader<Provider.LanguageModelV4StreamPart>
): Promise<Provider.LanguageModelV4StreamPart[]> {
  const parts: Provider.LanguageModelV4StreamPart[] = [];
  while (!parts.some((part) => part.type === "tool-input-delta")) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    parts.push(next.value);
  }
  return parts;
}

async function readRest(
  reader: ReadableStreamDefaultReader<Provider.LanguageModelV4StreamPart>
): Promise<Provider.LanguageModelV4StreamPart[]> {
  const parts: Provider.LanguageModelV4StreamPart[] = [];
  let next = await reader.read();
  while (!next.done) {
    parts.push(next.value);
    next = await reader.read();
  }
  return parts;
}

function controlledGate() {
  let open = (): void => {
    throw new Error("Gate was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

function markdownPayload(name: string, content: string): string {
  if (name === "hermes") {
    return `<tool_call>${JSON.stringify({ name: "write_markdown_file", arguments: { file_path: "stream-tool-input-visual-demo.md", line_count: "420", content } })}</tool_call>`;
  }
  if (name === "morph-xml") {
    return `<write_markdown_file><file_path>stream-tool-input-visual-demo.md</file_path><line_count>420</line_count><content>${content}</content></write_markdown_file>`;
  }
  if (name === "yaml-xml") {
    return `<write_markdown_file>\nfile_path: stream-tool-input-visual-demo.md\nline_count: "420"\ncontent: ${content}\n</write_markdown_file>`;
  }
  return `<tool_call><function=write_markdown_file><parameter=file_path>stream-tool-input-visual-demo.md</parameter><parameter=line_count>420</parameter><parameter=content>${content}</parameter></function></tool_call>`;
}

function numberPayload(
  name: string,
  finite: string,
  overflow: string,
  huge: string
): string {
  if (name === "hermes") {
    return `<tool_call>${JSON.stringify({ name: "coerce_numbers", arguments: { finite_int: finite, overflow_num: overflow, huge_int: huge } })}</tool_call>`;
  }
  if (name === "morph-xml") {
    return `<coerce_numbers><finite_int>${finite}</finite_int><overflow_num>${overflow}</overflow_num><huge_int>${huge}</huge_int></coerce_numbers>`;
  }
  if (name === "yaml-xml") {
    return `<coerce_numbers>\nfinite_int: "${finite}"\noverflow_num: "${overflow}"\nhuge_int: "${huge}"\n</coerce_numbers>`;
  }
  return `<tool_call><function=coerce_numbers><parameter=finite_int>${finite}</parameter><parameter=overflow_num>${overflow}</parameter><parameter=huge_int>${huge}</parameter></function></tool_call>`;
}

async function observeProtocolPayload(
  scenario: { readonly name: string; readonly protocol: TCMCoreProtocol },
  tools: Provider.LanguageModelV4FunctionTool[],
  payload: string,
  idPrefix: string
) {
  const source = createChunkedStream([payload], `${idPrefix}-${scenario.name}`);
  const output = await wrappedOutput(scenario.protocol, tools, source);
  return deltaObservation(await readRest(output.getReader()));
}

function expectMarkdownResult(
  observed: ReturnType<typeof deltaObservation>,
  content: string
): void {
  const parsed = JSON.parse(observed.toolCall?.input ?? "{}");
  expect(observed.deltas.length).toBeGreaterThanOrEqual(2);
  expect(observed.joined).toBe(observed.toolCall?.input);
  expect(parsed.file_path).toBe("stream-tool-input-visual-demo.md");
  expect(parsed.line_count).toBe(420);
  expect(parsed.content).toBe(content);
}

const protocols: readonly {
  readonly name: string;
  readonly protocol: TCMCoreProtocol;
}[] = [
  { name: "hermes", protocol: hermesProtocol() },
  { name: "morph-xml", protocol: morphXmlProtocol() },
  { name: "yaml-xml", protocol: yamlXmlProtocol() },
  { name: "qwen3coder", protocol: Qwen3CoderToolParser() },
  { name: "ui-tars-xml", protocol: uiTarsXmlProtocol() },
];

describe("wrapStream tool-call coercion large-chunk handling", () => {
  it("splits large single-chunk content into multiple tool-input deltas across protocols", async () => {
    const tools = [markdownTool()];
    const longContent = "single_chunk_long_content_".repeat(1000);
    for (const scenario of protocols) {
      const payload = markdownPayload(scenario.name, longContent);
      const observed = await observeProtocolPayload(
        scenario,
        tools,
        payload,
        "seed-one-chunk"
      );
      expectMarkdownResult(observed, longContent);
    }
  });

  it("streams morph-xml structure before close without exposing open string content", async () => {
    const longContent = "morph_long_content_segment_".repeat(700);
    const splitIndex = Math.floor(longContent.length * 0.72);
    const contentHead = longContent.slice(0, splitIndex);
    const contentTail = longContent.slice(splitIndex);
    const gate = controlledGate();
    const source = new ReadableStream<Provider.LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: "seed-morph-long-content",
          delta:
            "<write_markdown_file><file_path>stream-tool-input-visual-demo.md</file_path><line_count>420</line_count><content>" +
            contentHead,
        });
        await gate.promise;
        controller.enqueue({
          type: "text-delta",
          id: "seed-morph-long-content",
          delta: `${contentTail}</content></write_markdown_file>`,
        });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        controller.close();
      },
    });
    const reader = (
      await wrappedOutput(morphXmlProtocol(), [markdownTool()], source)
    ).getReader();
    const earlyParts = await readThroughDelta(reader);
    const earlyJoined = deltaObservation(earlyParts).joined;
    expect(earlyParts.some((part) => part.type === "tool-input-start")).toBe(
      true
    );
    expect(earlyParts.some((part) => part.type === "tool-call")).toBe(false);
    expect(earlyParts.some((part) => part.type === "tool-input-end")).toBe(
      false
    );
    expect(earlyJoined).toContain('"line_count":420');
    expect(earlyJoined).toContain('"content":"');
    expect(earlyJoined).not.toContain(contentHead.slice(0, 120));
    gate.open();
    const parts = [...earlyParts, ...(await readRest(reader))];
    expectMarkdownResult(deltaObservation(parts), longContent);
  });

  it("keeps huge-number coercion decisions aligned between streamed deltas and final input across protocols", async () => {
    const finiteIntRaw = "9007199254740993";
    const overflowNumberRaw = "1e400";
    const hugeDigitsRaw = "9".repeat(500);
    const tools: Provider.LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "coerce_numbers",
        inputSchema: {
          type: "object",
          properties: {
            finite_int: { type: "integer" },
            overflow_num: { type: ["number", "string"] },
            huge_int: { type: ["integer", "string"] },
          },
          required: ["finite_int", "overflow_num", "huge_int"],
        },
      },
    ];
    for (const scenario of protocols) {
      const payload = numberPayload(
        scenario.name,
        finiteIntRaw,
        overflowNumberRaw,
        hugeDigitsRaw
      );
      const observed = await observeProtocolPayload(
        scenario,
        tools,
        payload,
        "seed-huge"
      );
      const parsed = JSON.parse(observed.toolCall?.input ?? "{}");
      expect(observed.deltas.length).toBeGreaterThanOrEqual(2);
      expect(observed.joined).toBe(observed.toolCall?.input);
      expect(observed.joined.includes('"finite_int":"')).toBe(false);
      expect(observed.joined).toContain('"overflow_num":"1e400"');
      expect(observed.joined).toContain('"huge_int":"');
      expect(parsed.finite_int).toBe(Number(finiteIntRaw));
      expect(typeof parsed.finite_int).toBe("number");
      expect(parsed.overflow_num).toBe(overflowNumberRaw);
      expect(typeof parsed.overflow_num).toBe("string");
      expect(parsed.huge_int).toBe(hugeDigitsRaw);
      expect(typeof parsed.huge_int).toBe("string");
    }
  });
});
