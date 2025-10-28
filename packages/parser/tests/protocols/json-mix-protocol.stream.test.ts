import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) {
      out.push(c);
    }
    return out;
  })();
}

describe("jsonMixProtocol streaming", () => {
  it("parses normal tool_call blocks into tool-call events", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "pre " });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " post" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool.toolName).toBe("x");
    expect(JSON.parse(tool.input)).toEqual({ a: 1 });
  });

  it("normalizes legacy <tool_call> tags and parses", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"y","arguments":{}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool.toolName).toBe("y");
  });

  it("on parse error emits original text via text-start/delta/end and calls onError", async () => {
    const onError = vi.fn();
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>{bad}</tool_call>",
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
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain("<tool_call>{bad}</tool_call>");
    expect(out.some((c) => c.type === "text-start")).toBe(true);
    expect(out.some((c) => c.type === "text-end")).toBe(true);
    expect(onError).toHaveBeenCalled();
  });
});

describe("jsonMixProtocol streaming edge cases", () => {
  it("parses tool call when content split across chunks", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "before <tool_call>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '{"name":"a","arguments":{}',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "}</tool_call> after",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toMatchObject({
      type: "tool-call",
      toolName: "a",
      input: "{}",
    });
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("before ");
    expect(out.find((c) => c.type === "finish")).toBeTruthy();
  });

  it("supports legacy <tool_call> tags mixed in chunks", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"b","arguments":{}}',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool_call>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toMatchObject({ type: "tool-call", toolName: "b" });
  });

  it("emits original text on malformed JSON and calls onError", async () => {
    const onError = vi.fn();
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>{invalid}</tool_call>",
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
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("<tool_call>{invalid}</tool_call>");
    expect(onError).toHaveBeenCalled();
  });

  it("flushes buffered partial tool_call at finish as text", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"c"',
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
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain('<tool_call>{"name":"c"');
  });

  it("parses a single call whose tags are split across many chunks (>=6)", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<tool" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "_ca" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "ll>" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: '{"name":"d"' });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: ',"argume',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: 'nts":{',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '"location"',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: ':"NY"' });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "}}" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "_" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "call>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).location).toBe("NY");
    expect(tool.toolName).toBe("d");
  });
});

describe("jsonMixProtocol content isolation", () => {
  it("does not expose JSON content inside tool_call tags in text output", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Let me check the weather.\n\n",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta:
            '<tool_call>{"name":"get_weather","arguments":{"city":"New York"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "\n\nThe weather looks good!",
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify tool call was parsed correctly
    expect(tool?.toolName).toBe("get_weather");
    const parsed = JSON.parse(tool.input);
    expect(parsed).toEqual({ city: "New York" });

    // Verify JSON content and tags are NOT in the output text
    expect(fullText).not.toContain("<tool_call>");
    expect(fullText).not.toContain("</tool_call>");
    expect(fullText).not.toContain('"name":"get_weather"');
    expect(fullText).not.toContain('"city":"New York"');

    // Verify only the surrounding text is present
    expect(fullText).toContain("Let me check the weather.");
    expect(fullText).toContain("The weather looks good!");
  });

  it("handles multiple consecutive tool calls without exposing JSON content", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "First, " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta:
            '<tool_call>{"name":"get_location","arguments":{}}</tool_call>',
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " then " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta:
            '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>',
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " done!" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));
    const toolCalls = out.filter((c) => c.type === "tool-call") as any[];
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify both tool calls were parsed
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("get_location");
    expect(toolCalls[1].toolName).toBe("get_weather");

    // Verify no JSON content or tags in output
    expect(fullText).not.toContain("<tool_call>");
    expect(fullText).not.toContain("</tool_call>");
    expect(fullText).not.toContain('"name":');
    expect(fullText).not.toContain('"arguments":');
    expect(fullText).not.toContain("get_location");
    expect(fullText).not.toContain("get_weather");
    expect(fullText).not.toContain("Tokyo");

    // Verify only surrounding text
    expect(fullText).toContain("First,");
    expect(fullText).toContain(" then ");
    expect(fullText).toContain(" done!");
  });

  it("properly emits text-start and text-end events around tool calls", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Before tool call ",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta:
            '<tool_call>{"name":"test_tool","arguments":{"value":"test"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: " After tool call",
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
  });

  it("handles tool call split across chunks without exposing JSON in text", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Computing: " });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "<tool_call>" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: '{"name":"calc"' });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: ',"arguments":{"x":10',
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: ',"y":20}}' });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "</tool_call>" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "\nResult ready!" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call") as any;
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify tool call parsed correctly
    expect(tool?.toolName).toBe("calc");
    const parsed = JSON.parse(tool.input);
    expect(parsed).toEqual({ x: 10, y: 20 });

    // Verify no JSON content or tags in output
    expect(fullText).not.toContain("<tool_call>");
    expect(fullText).not.toContain("</tool_call>");
    expect(fullText).not.toContain('"name":"calc"');
    expect(fullText).not.toContain('"arguments"');

    // Verify only surrounding text
    expect(fullText).toContain("Computing:");
    expect(fullText).toContain("Result ready!");
  });
});
