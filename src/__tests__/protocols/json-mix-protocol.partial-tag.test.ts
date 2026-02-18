import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { jsonMixProtocol } from "../../core/protocols/json-mix-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

function joinTextDeltas(parts: LanguageModelV3StreamPart[]): string {
  const deltas: string[] = [];
  for (const part of parts) {
    if (part.type !== "text-delta") {
      continue;
    }
    const delta = (part as unknown as { delta?: unknown }).delta;
    if (typeof delta === "string") {
      deltas.push(delta);
    }
  }
  return deltas.join("");
}

type ToolCallPart = LanguageModelV3StreamPart & {
  type: "tool-call";
  toolName: string;
  input: string;
};

function isToolCallPart(part: LanguageModelV3StreamPart): part is ToolCallPart {
  if (part.type !== "tool-call") {
    return false;
  }
  const maybe = part as unknown as { toolName?: unknown; input?: unknown };
  return typeof maybe.toolName === "string" && typeof maybe.input === "string";
}

describe("jsonMixProtocol partial tag handling", () => {
  it("breaks inner loop when only partial start tag suffix present and publishes buffer", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "before <tool_c" });
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
    const text = joinTextDeltas(out);
    expect(text).toContain("before <tool_c");
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
  });

  it("keeps the longest overlapping start-tag suffix across chunks", async () => {
    const toolCallStart = "ababax";
    const toolCallEnd = "ENDTAG";
    const protocol = jsonMixProtocol({ toolCallStart, toolCallEnd });
    const transformer = protocol.createStreamParser({ tools: [] });

    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "before|ababa" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `x{"name":"t","arguments":{"value":1}}${toolCallEnd}|after`,
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

    const text = joinTextDeltas(out);

    expect(text).toBe("before||after");
    expect(text).not.toContain("ababa");
    expect(text).not.toContain(toolCallStart);

    const toolCalls = out.filter(isToolCallPart);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "t",
      input: '{"value":1}',
    });
  });
});
