import type {
  JSONSchema7Definition,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

function makeTool(
  name: string,
  properties: Record<string, JSONSchema7Definition>,
  additionalProperties?: boolean
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties,
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    },
  };
}

// Intentionally accepts malformed schemas so tests can exercise runtime rejection.
type ToolCallPart = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;
type TextDeltaPart = Extract<LanguageModelV4StreamPart, { type: "text-delta" }>;

function isToolCallPart(part: LanguageModelV4StreamPart): part is ToolCallPart {
  return part.type === "tool-call";
}

function isTextDeltaPart(
  part: LanguageModelV4StreamPart
): part is TextDeltaPart {
  return part.type === "text-delta";
}

function makeDeepArrayJson(depth: number): string {
  let value = "0";
  for (let index = 0; index < depth; index += 1) {
    value = `[${value}]`;
  }
  return value;
}

function expectNoToolInputLifecycle(
  parts: readonly LanguageModelV4StreamPart[]
): void {
  expect(parts.some((part) => part.type === "tool-input-start")).toBe(false);
  expect(parts.some((part) => part.type === "tool-input-delta")).toBe(false);
  expect(parts.some((part) => part.type === "tool-input-end")).toBe(false);
}

function collectTextDeltas(
  parts: readonly LanguageModelV4StreamPart[]
): string {
  return parts
    .filter(isTextDeltaPart)
    .map((part) => part.delta)
    .join("");
}

describe("json-repair.test split 1", () => {
  it("repairs streaming tool call with unescaped quotes and emits tool-call", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find(isToolCallPart);
    expect(tool).toBeTruthy();
    expect(tool?.toolName).toBe("edit");
    const args = JSON.parse(tool?.input ?? "{}");
    expect(args.content).toBe('He said "hello" to me');
    // Should not emit any text-delta with raw tool call markup
    expect(collectTextDeltas(out)).not.toContain("<tool_call>");
  });

  it("does not repair relaxed top-level keys even when argument keys are strict JSON", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool("write", {
        content: { type: "string" },
        path: { type: "string" },
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError, emitRawToolCallTextOnError: true },
    });
    const text =
      '<tool_call>{name:"write",arguments:{"content":"He said "hi" there","path":"/tmp/a"}}</tool_call>';
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: text,
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );

    expect(out.find(isToolCallPart)).toBeUndefined();
    expectNoToolInputLifecycle(out);
    expect(collectTextDeltas(out)).toContain(text);
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed instead of throwing for deeply nested arguments", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const text = `<tool_call>{"name":"deep","arguments":{"data":${makeDeepArrayJson(
      20_000
    )}}}</tool_call>`;
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError, emitRawToolCallTextOnError: true },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: text,
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );

    expect(out.find(isToolCallPart)).toBeUndefined();
    expectNoToolInputLifecycle(out);
    expect(collectTextDeltas(out)).toContain(text);
    expect(onError).toHaveBeenCalled();
  });

  it("repairs streaming unescaped quotes before a right brace character", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [makeTool("edit", { content: { type: "string" } }, false)],
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"edit","arguments":{"content":"He said "}" there"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool?.type).toBe("tool-call");
    if (tool?.type !== "tool-call") {
      throw new Error("Expected repaired tool call");
    }
    expect(JSON.parse(tool.input)).toEqual({ content: 'He said "}" there' });
  });

  it("repairs with known tool schema (tools parameter provided)", async () => {
    const tools = [
      makeTool("write", {
        path: { type: "string" },
        content: { type: "string" },
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '{"name":"write","arguments":{"path":"/tmp/test.js","content":"var x = "hello";',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '"}}',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "</tool_call>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find(isToolCallPart);
    expect(tool).toBeTruthy();
    expect(tool?.toolName).toBe("write");
    const args = JSON.parse(tool?.input ?? "{}");
    expect(args.path).toBe("/tmp/test.js");
    expect(args.content).toContain('"hello"');
  });

  it("drops schema-unknown keys when additionalProperties is false", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool(
        "write",
        {
          path: { type: "string" },
          content: { type: "string" },
        },
        false
      ),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"He said "hi" there","debug":"drop me","path":"/tmp/a"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find(isToolCallPart);
    expect(tool?.toolName).toBe("write");
    expect(JSON.parse(tool?.input ?? "{}")).toEqual({
      content: 'He said "hi" there',
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops schema-unknown keys in strict repair even when arguments parse cleanly", async () => {
    const onError = vi.fn();
    const tools = [
      makeTool(
        "write",
        {
          path: { type: "string" },
          content: { type: "string" },
        },
        false
      ),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find(isToolCallPart);
    expect(tool?.toolName).toBe("write");
    expect(JSON.parse(tool?.input ?? "{}")).toEqual({
      content: "ok",
      path: "/tmp/a",
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
