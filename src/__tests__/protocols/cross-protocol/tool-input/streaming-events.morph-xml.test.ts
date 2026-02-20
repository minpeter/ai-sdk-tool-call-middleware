import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  createInterleavedStream,
  extractToolInputTimeline,
  runProtocolStreamParser,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: morph xml", () => {
  const fixture = toolInputStreamFixtures.xml;
  const protocol = morphXmlProtocol();

  it("xml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: fixture.progressiveChunks,
    });

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("xml protocol emits progress deltas for union-typed object schemas", async () => {
    const unionWeatherTool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "get_weather",
      description: "Get weather information",
      inputSchema: {
        type: ["object", "null"],
        properties: {
          location: { type: "string" },
          unit: { type: "string" },
        },
        required: ["location"],
      },
    };

    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: [unionWeatherTool],
      chunks: fixture.progressiveChunks,
    });

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("xml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: fixture.finishReconcileChunks,
    });

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe(fixture.expectedFinishInput);
  });

  it("xml finish reconciliation rejects unclosed payloads with trailing plain text", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: ["<get_weather><location>Seoul</location> done"],
    });

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("xml finish reconciliation rejects unclosed payloads with tagless plain text body", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: ["<get_weather>hello"],
    });

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("xml protocol does not prematurely finalize tool call when non-text chunks are interleaved", async () => {
    const out = await runProtocolStreamParser({
      protocol,
      tools: fixture.tools,
      stream: createInterleavedStream([
        {
          type: "text-delta",
          id: "fixture",
          delta: "<get_weather>\n<location>Seo",
        },
        {
          type: "tool-call",
          toolCallId: "passthrough-xml",
          toolName: "passthrough_marker",
          input: "{}",
        } satisfies LanguageModelV3StreamPart,
        {
          type: "text-delta",
          id: "fixture",
          delta: "ul</location>\n<unit>celsius</unit>\n</get_weather>",
        },
      ]),
    });

    const parsedCalls = out.filter(
      (part) => part.type === "tool-call" && part.toolName === "get_weather"
    ) as Array<{
      type: "tool-call";
      toolName: string;
      input: string;
    }>;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(parsedCalls).toHaveLength(1);
    expect(parsedCalls[0].input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(leakedText).not.toContain("<get_weather>");
    expect(leakedText).not.toContain("</get_weather>");
  });

  it("xml malformed fixture does not leave dangling tool-input stream", async () => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: fixture.tools,
      chunks: fixture.malformedChunks,
    });

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts.length).toBe(ends.length);
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });
});
