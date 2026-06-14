import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
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
  properties: Record<string, { type: string }>,
  additionalProperties?: boolean
): LanguageModelV3FunctionTool {
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

describe("hermesProtocol streaming JSON repair", () => {
  it("repairs streaming tool call with unescaped quotes and emits tool-call", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("edit");
    const args = JSON.parse(tool.input);
    expect(args.content).toBe('He said "hello" to me');
    // Should not emit any text-delta with raw tool call markup
    const textDeltas = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(textDeltas).not.toContain("<tool_call>");
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("write");
    const args = JSON.parse(tool.input);
    expect(args.path).toBe("/tmp/test.js");
    expect(args.content).toContain('"hello"');
  });

  it("calls onError for schema-unknown keys when additionalProperties is false", async () => {
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
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
