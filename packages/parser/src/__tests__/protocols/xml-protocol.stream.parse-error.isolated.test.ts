import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

describe("morphXmlProtocol streaming with malformed XML", () => {
  it("gracefully recovers malformed XML by parsing available content", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const onError = vi.fn();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<a><x>1</x><unclosed>tag</a>",
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
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "a",
    });
    const input = JSON.parse((toolCalls[0] as { input: string }).input);
    expect(input).toHaveProperty("x", 1);
    expect(input).toHaveProperty("unclosed", "tag");
  });
});
