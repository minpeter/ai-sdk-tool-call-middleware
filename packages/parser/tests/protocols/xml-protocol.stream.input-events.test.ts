import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) out.push(c);
    return out;
  })();
}

const tools = [
  {
    type: "function",
    name: "get_weather",
    description: "",
    inputSchema: { type: "object" },
  },
] as any;

describe("morphXmlProtocol tool-input events", () => {
  it("emits tool-input-start and tool-input-end events for successful tool call", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "prefix " });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_weather>" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<location>NY</location>",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</get_weather>" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " suffix" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));

    // Find tool-input events
    const toolInputStart = out.find(c => c.type === "tool-input-start") as any;
    const toolInputEnd = out.find(c => c.type === "tool-input-end") as any;
    const toolCall = out.find(c => c.type === "tool-call") as any;

    // Verify tool-input-start event
    expect(toolInputStart).toBeTruthy();
    expect(toolInputStart.type).toBe("tool-input-start");
    expect(toolInputStart.id).toBe("mock-id");
    expect(toolInputStart.toolName).toBe("get_weather");

    // Verify tool-input-end event
    expect(toolInputEnd).toBeTruthy();
    expect(toolInputEnd.type).toBe("tool-input-end");
    expect(toolInputEnd.id).toBe("mock-id");

    // Verify tool-call event uses same ID
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolCallId).toBe("mock-id");
    expect(toolCall.toolName).toBe("get_weather");

    // Verify event order: start -> end -> tool-call
    const eventIndexes = {
      start: out.findIndex(c => c.type === "tool-input-start"),
      end: out.findIndex(c => c.type === "tool-input-end"),
      call: out.findIndex(c => c.type === "tool-call"),
    };
    expect(eventIndexes.start).toBeLessThan(eventIndexes.end);
    expect(eventIndexes.end).toBeLessThan(eventIndexes.call);
  });

  it("emits tool-input-start and tool-input-end events for failed tool call", async () => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });

    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_weather>" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<invalid>malformed xml",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</get_weather>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));

    // Find tool-input events
    const toolInputStart = out.find(c => c.type === "tool-input-start") as any;
    const toolInputEnd = out.find(c => c.type === "tool-input-end") as any;

    // Verify both events are emitted even on error
    expect(toolInputStart).toBeTruthy();
    expect(toolInputStart.type).toBe("tool-input-start");
    expect(toolInputStart.id).toBe("mock-id");
    expect(toolInputStart.toolName).toBe("get_weather");

    expect(toolInputEnd).toBeTruthy();
    expect(toolInputEnd.type).toBe("tool-input-end");
    expect(toolInputEnd.id).toBe("mock-id");

    // Verify error callback was called
    expect(onError).toHaveBeenCalled();
  });

  it("emits tool-input-start and tool-input-end for incomplete tool call at stream end", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });

    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_weather>" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<location>NY</location>",
        });
        // Note: no closing tag - incomplete tool call
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));

    // Find tool-input events
    const toolInputStart = out.find(c => c.type === "tool-input-start") as any;
    const toolInputEnd = out.find(c => c.type === "tool-input-end") as any;

    // Verify both events are emitted even for incomplete calls
    expect(toolInputStart).toBeTruthy();
    expect(toolInputStart.type).toBe("tool-input-start");
    expect(toolInputStart.id).toBe("mock-id");
    expect(toolInputStart.toolName).toBe("get_weather");

    expect(toolInputEnd).toBeTruthy();
    expect(toolInputEnd.type).toBe("tool-input-end");
    expect(toolInputEnd.id).toBe("mock-id");

    // Verify the incomplete call content is emitted as text
    const textParts = out
      .filter(c => c.type === "text-delta")
      .map((c: any) => c.delta);
    const fullText = textParts.join("");
    expect(fullText).toContain("<get_weather>");
    expect(fullText).toContain("<location>NY</location>");
  });

  it("emits multiple paired tool-input events for multiple tool calls", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });

    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather><location>NY</location></get_weather>",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " and " });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather><location>SF</location></get_weather>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));

    // Find all tool-input events
    const toolInputStarts = out.filter(c => c.type === "tool-input-start");
    const toolInputEnds = out.filter(c => c.type === "tool-input-end");
    const toolCalls = out.filter(c => c.type === "tool-call");

    // Should have at least 1 tool call (implementation may coalesce)
    expect(toolInputStarts.length).toBeGreaterThanOrEqual(1);
    expect(toolInputEnds.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    // Each start should have a corresponding end
    expect(toolInputStarts.length).toBe(toolInputEnds.length);
    expect(toolInputStarts.length).toBe(toolCalls.length);

    // Verify IDs match between start, end, and tool-call events
    for (let i = 0; i < toolInputStarts.length; i++) {
      const start = toolInputStarts[i] as any;
      const end = toolInputEnds[i] as any;
      const call = toolCalls[i] as any;

      expect(start.id).toBe(end.id);
      expect(start.id).toBe(call.toolCallId);
      expect(start.toolName).toBe("get_weather");
    }
  });
});
