import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../src/protocols/morph-xml-protocol";

describe("morphXmlProtocol streaming parse error with malformed XML", () => {
  it("invokes onError and emits original text on parser exception", async () => {
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
        // Use malformed XML that will cause parsing to fail
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<a><x>1</x><unclosed>tag</a>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(rs.pipeThrough(transformer));
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain("<a><x>1</x><unclosed>tag</a>");
    expect(onError).toHaveBeenCalled();
  });
});
