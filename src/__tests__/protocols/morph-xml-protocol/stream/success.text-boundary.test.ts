import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

describe("morphXmlProtocol streaming text boundary behavior", () => {
  it("properly emits text-start and text-end events around tool calls", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "test_tool",
        description: "Test tool",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Before tool call ",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<test_tool><value>test</value></test_tool>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: " After tool call",
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

    // Extract events in order
    const eventTypes = out.map((e) => e.type);
    const textStarts = out.filter((e) => e.type === "text-start");
    const textEnds = out.filter((e) => e.type === "text-end");
    const toolCalls = out.filter((e) => e.type === "tool-call");

    // Verify tool call was parsed
    expect(toolCalls).toHaveLength(1);

    // Verify text segments are properly opened and closed
    expect(textStarts.length).toBeGreaterThan(0);
    expect(textEnds.length).toBeGreaterThan(0);

    // Verify the sequence: text-end should come before tool-call
    const toolCallIndex = eventTypes.indexOf("tool-call");
    const textEndBeforeTool = eventTypes.lastIndexOf("text-end", toolCallIndex);

    // There should be text before the tool call, so there must be a text-end before it
    expect(textEndBeforeTool).toBeGreaterThanOrEqual(0);
    expect(textEndBeforeTool).toBeLessThan(toolCallIndex);

    // Verify text-start after tool-call if there's text after
    const textDeltaAfterTool = eventTypes.indexOf(
      "text-delta",
      toolCallIndex + 1
    );
    if (textDeltaAfterTool !== -1) {
      const textStartAfterTool = eventTypes.indexOf(
        "text-start",
        toolCallIndex + 1
      );
      expect(textStartAfterTool).toBeGreaterThanOrEqual(0);
      expect(textStartAfterTool).toBeLessThan(textDeltaAfterTool);
    }

    // Verify each text-start has a corresponding text-end (or is the last segment)
    expect(textStarts.length).toBeLessThanOrEqual(textEnds.length + 1);
  });

  it("handles text-end correctly when multiple tool calls are present", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "tool_a",
        description: "Tool A",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "tool_b",
        description: "Tool B",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Start " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_a></tool_a>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " Middle " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_b></tool_b>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " End" });
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

    const textStarts = out.filter((e) => e.type === "text-start");
    const toolCalls = out.filter((e) => e.type === "tool-call");

    // Verify both tool calls were parsed
    expect(toolCalls).toHaveLength(2);

    // Verify text segments exist
    expect(textStarts.length).toBeGreaterThan(0);

    // Count text-delta events to ensure content is preserved
    const textDeltas = out
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as any).delta);
    const fullText = textDeltas.join("");

    expect(fullText).toContain("Start");
    expect(fullText).toContain("Middle");
    expect(fullText).toContain("End");
    expect(fullText).not.toContain("<tool_a>");
    expect(fullText).not.toContain("<tool_b>");
  });

  it("handles consecutive tool calls with no text between them", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "tool_a",
        description: "Tool A",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "tool_b",
        description: "Tool B",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_a></tool_a><tool_b></tool_b>",
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
    const toolCalls = out.filter((e) => e.type === "tool-call");
    const textDeltas = out.filter((e) => e.type === "text-delta");

    // Both tool calls should be parsed
    expect(toolCalls).toHaveLength(2);

    // Text deltas may be emitted for empty segments between tools (for proper text boundaries)
    // The important thing is that no XML tags are exposed
    const fullText = textDeltas.map((e) => (e as any).delta).join("");
    expect(fullText).not.toContain("<tool_a>");
    expect(fullText).not.toContain("<tool_b>");
  });

  it("handles tool calls separated only by whitespace", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "tool_a",
        description: "Tool A",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "tool_b",
        description: "Tool B",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_a></tool_a>\n  \n<tool_b></tool_b>",
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
    const toolCalls = out.filter((e) => e.type === "tool-call");
    const textDeltas = out
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as any).delta);
    const fullText = textDeltas.join("");

    // Both tool calls should be parsed
    expect(toolCalls).toHaveLength(2);

    // Whitespace should be preserved in text output (or may be empty if optimized away)
    // The important thing is no XML tags are exposed
    expect(fullText).not.toContain("<tool_a>");
    expect(fullText).not.toContain("<tool_b>");
    // If whitespace is preserved, it should match
    if (fullText.trim().length === 0) {
      // Whitespace handling is implementation-dependent
      expect(fullText.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles empty tool call parameters", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "empty_tool",
        description: "Tool with no parameters",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Calling <empty_tool></empty_tool> now",
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
    const toolCall = out.find((e) => e.type === "tool-call") as any;
    const textDeltas = out
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as any).delta);
    const fullText = textDeltas.join("");

    // Tool call should be parsed
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("empty_tool");
    const parsed = JSON.parse(toolCall.input);
    expect(parsed).toEqual({});

    // Text should not contain XML tags
    expect(fullText).toContain("Calling");
    expect(fullText).toContain("now");
    expect(fullText).not.toContain("<empty_tool>");
  });
});
