import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import {
  qwen3CoderProtocol,
  uiTarsXmlProtocol,
} from "../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";
import { stopFinishReason, zeroUsage } from "../test-helpers";

async function readUntilStreamPart(options: {
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>;
  stopType: LanguageModelV4StreamPart["type"];
  timeoutMs?: number;
}): Promise<LanguageModelV4StreamPart[]> {
  const { reader, stopType, timeoutMs = 2000 } = options;
  const parts: LanguageModelV4StreamPart[] = [];

  const readWithTimeout = async (): Promise<
    ReadableStreamReadResult<LanguageModelV4StreamPart>
  > => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(`Did not receive ${stopType} within ${timeoutMs}ms`)
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };

  while (true) {
    const { done, value } = await readWithTimeout();
    if (done || !value) {
      break;
    }
    parts.push(value);
    if (value.type === stopType) {
      break;
    }
  }

  return parts;
}

function readUntilToolInputDelta(options: {
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>;
  timeoutMs?: number;
}): Promise<LanguageModelV4StreamPart[]> {
  return readUntilStreamPart({ ...options, stopType: "tool-input-delta" });
}

describe("wrapStream tool-call coercion large-chunk handling", () => {
  it("splits large single-chunk content into multiple tool-input deltas across protocols", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
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
      },
    ];

    const longContent = "single_chunk_long_content_".repeat(1000);
    const scenarios: Array<{
      name: string;
      protocol: TCMCoreProtocol;
      payload: string;
    }> = [
      {
        name: "hermes",
        protocol: hermesProtocol(),
        payload: `<tool_call>${JSON.stringify({
          name: "write_markdown_file",
          arguments: {
            file_path: "stream-tool-input-visual-demo.md",
            line_count: "420",
            content: longContent,
          },
        })}</tool_call>`,
      },
      {
        name: "morph-xml",
        protocol: morphXmlProtocol(),
        payload:
          "<write_markdown_file><file_path>stream-tool-input-visual-demo.md</file_path><line_count>420</line_count><content>" +
          longContent +
          "</content></write_markdown_file>",
      },
      {
        name: "yaml-xml",
        protocol: yamlXmlProtocol(),
        payload:
          '<write_markdown_file>\nfile_path: stream-tool-input-visual-demo.md\nline_count: "420"\ncontent: ' +
          longContent +
          "\n</write_markdown_file>",
      },
      {
        name: "qwen3coder",
        protocol: qwen3CoderProtocol(),
        payload:
          "<tool_call><function=write_markdown_file><parameter=file_path>stream-tool-input-visual-demo.md</parameter><parameter=line_count>420</parameter><parameter=content>" +
          longContent +
          "</parameter></function></tool_call>",
      },
      {
        name: "ui-tars-xml",
        protocol: uiTarsXmlProtocol(),
        payload:
          "<tool_call><function=write_markdown_file><parameter=file_path>stream-tool-input-visual-demo.md</parameter><parameter=line_count>420</parameter><parameter=content>" +
          longContent +
          "</parameter></function></tool_call>",
      },
    ];

    for (const scenario of scenarios) {
      const doStream = vi.fn().mockResolvedValue({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({
              type: "text-delta",
              id: `seed-one-chunk-${scenario.name}`,
              delta: scenario.payload,
            });
            controller.enqueue({
              type: "finish",
              finishReason: stopFinishReason,
              usage: zeroUsage,
            });
            controller.close();
          },
        }),
      });

      const result = await wrapStream({
        protocol: scenario.protocol,
        doStream,
        doGenerate: vi.fn(),
        params: {
          providerOptions: {
            toolCallMiddleware: {
              originalTools: originalToolsSchema.encode(tools),
            },
          },
        },
      });

      const parts = await convertReadableStreamToArray(result.stream);
      const deltas = parts.filter(
        (
          part
        ): part is Extract<
          LanguageModelV4StreamPart,
          { type: "tool-input-delta" }
        > => part.type === "tool-input-delta"
      );
      const joined = deltas.map((part) => part.delta).join("");
      const toolCall = parts.find(
        (
          part
        ): part is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> =>
          part.type === "tool-call" && part.toolName === "write_markdown_file"
      );
      const parsed = JSON.parse(toolCall?.input ?? "{}") as {
        content: string;
        file_path: string;
        line_count: number;
      };

      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(joined).toBe(toolCall?.input);
      expect(parsed.file_path).toBe("stream-tool-input-visual-demo.md");
      expect(parsed.line_count).toBe(420);
      expect(parsed.content).toBe(longContent);
    }
  });

  it("streams morph-xml structure before close without exposing open string content", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
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
      },
    ];

    const longContent = "morph_long_content_segment_".repeat(700);
    const splitIndex = Math.floor(longContent.length * 0.72);
    const contentHead = longContent.slice(0, splitIndex);
    const contentTail = longContent.slice(splitIndex);

    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({
            type: "text-delta",
            id: "seed-morph-long-content",
            delta:
              "<write_markdown_file><file_path>stream-tool-input-visual-demo.md</file_path><line_count>420</line_count><content>" +
              contentHead,
          });
          await secondChunkGate;
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
      }),
    });

    const result = await wrapStream({
      protocol: morphXmlProtocol(),
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    });

    const reader = result.stream.getReader();
    const earlyParts = await readUntilToolInputDelta({ reader });

    const earlyJoined = earlyParts
      .filter(
        (
          part
        ): part is Extract<
          LanguageModelV4StreamPart,
          { type: "tool-input-delta" }
        > => part.type === "tool-input-delta"
      )
      .map((part) => part.delta)
      .join("");

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

    releaseSecondChunk();

    const remainingParts: LanguageModelV4StreamPart[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      remainingParts.push(value);
    }

    const parts = [...earlyParts, ...remainingParts];
    const deltas = parts.filter(
      (
        part
      ): part is Extract<
        LanguageModelV4StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    );
    const joined = deltas.map((part) => part.delta).join("");
    const toolCall = parts.find(
      (
        part
      ): part is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call" && part.toolName === "write_markdown_file"
    );
    const parsed = JSON.parse(toolCall?.input ?? "{}") as {
      content: string;
      file_path: string;
      line_count: number;
    };

    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(joined).toBe(toolCall?.input);
    expect(parsed.file_path).toBe("stream-tool-input-visual-demo.md");
    expect(parsed.line_count).toBe(420);
    expect(parsed.content).toBe(longContent);
  });

  it("keeps huge-number coercion decisions aligned between streamed deltas and final input across protocols", async () => {
    const finiteIntRaw = "9007199254740993";
    const overflowNumberRaw = "1e400";
    const hugeDigitsRaw = "9".repeat(500);

    const tools: LanguageModelV4FunctionTool[] = [
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

    const scenarios: Array<{
      name: string;
      payload: string;
      protocol: TCMCoreProtocol;
    }> = [
      {
        name: "hermes",
        protocol: hermesProtocol(),
        payload: `<tool_call>${JSON.stringify({
          name: "coerce_numbers",
          arguments: {
            finite_int: finiteIntRaw,
            overflow_num: overflowNumberRaw,
            huge_int: hugeDigitsRaw,
          },
        })}</tool_call>`,
      },
      {
        name: "morph-xml",
        protocol: morphXmlProtocol(),
        payload:
          "<coerce_numbers><finite_int>" +
          finiteIntRaw +
          "</finite_int><overflow_num>" +
          overflowNumberRaw +
          "</overflow_num><huge_int>" +
          hugeDigitsRaw +
          "</huge_int></coerce_numbers>",
      },
      {
        name: "yaml-xml",
        protocol: yamlXmlProtocol(),
        payload:
          '<coerce_numbers>\nfinite_int: "' +
          finiteIntRaw +
          '"\noverflow_num: "' +
          overflowNumberRaw +
          '"\nhuge_int: "' +
          hugeDigitsRaw +
          '"\n</coerce_numbers>',
      },
      {
        name: "qwen3coder",
        protocol: qwen3CoderProtocol(),
        payload:
          "<tool_call><function=coerce_numbers><parameter=finite_int>" +
          finiteIntRaw +
          "</parameter><parameter=overflow_num>" +
          overflowNumberRaw +
          "</parameter><parameter=huge_int>" +
          hugeDigitsRaw +
          "</parameter></function></tool_call>",
      },
      {
        name: "ui-tars-xml",
        protocol: uiTarsXmlProtocol(),
        payload:
          "<tool_call><function=coerce_numbers><parameter=finite_int>" +
          finiteIntRaw +
          "</parameter><parameter=overflow_num>" +
          overflowNumberRaw +
          "</parameter><parameter=huge_int>" +
          hugeDigitsRaw +
          "</parameter></function></tool_call>",
      },
    ];

    for (const scenario of scenarios) {
      const doStream = vi.fn().mockResolvedValue({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({
              type: "text-delta",
              id: `seed-huge-${scenario.name}`,
              delta: scenario.payload,
            });
            controller.enqueue({
              type: "finish",
              finishReason: stopFinishReason,
              usage: zeroUsage,
            });
            controller.close();
          },
        }),
      });

      const result = await wrapStream({
        protocol: scenario.protocol,
        doStream,
        doGenerate: vi.fn(),
        params: {
          providerOptions: {
            toolCallMiddleware: {
              originalTools: originalToolsSchema.encode(tools),
            },
          },
        },
      });

      const parts = await convertReadableStreamToArray(result.stream);
      const deltas = parts.filter(
        (
          part
        ): part is Extract<
          LanguageModelV4StreamPart,
          { type: "tool-input-delta" }
        > => part.type === "tool-input-delta"
      );
      const joined = deltas.map((part) => part.delta).join("");
      const toolCall = parts.find(
        (
          part
        ): part is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> =>
          part.type === "tool-call" && part.toolName === "coerce_numbers"
      );
      const parsed = JSON.parse(toolCall?.input ?? "{}") as {
        finite_int: number;
        huge_int: string;
        overflow_num: string;
      };

      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(joined).toBe(toolCall?.input);
      expect(joined.includes('"finite_int":"')).toBe(false);
      expect(joined).toContain('"overflow_num":"1e400"');
      expect(joined).toContain('"huge_int":"');
      expect(parsed.finite_int).toBe(Number(finiteIntRaw));
      expect(typeof parsed.finite_int).toBe("number");
      expect(parsed.overflow_num).toBe(overflowNumberRaw);
      expect(typeof parsed.overflow_num).toBe("string");
      expect(parsed.huge_int).toBe(hugeDigitsRaw);
      expect(typeof parsed.huge_int).toBe("string");
    }
  });
});
