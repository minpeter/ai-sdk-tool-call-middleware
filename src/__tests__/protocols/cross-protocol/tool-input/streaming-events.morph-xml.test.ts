import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  collectTextDeltas,
  requireToolCall,
  runStreamingEventCase,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";
import {
  createInterleavedStream,
  runProtocolStreamParser,
} from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: morph xml", () => {
  const fixture = toolInputStreamFixtures.xml;
  const protocol = morphXmlProtocol();

  function runMorphStream(
    chunks: readonly string[],
    tools: LanguageModelV4FunctionTool[] = fixture.tools
  ) {
    return runStreamingEventCase({
      protocol,
      tools,
      chunks,
      id: "fixture",
    });
  }

  function expectCompleteTimeline(
    out: readonly LanguageModelV4StreamPart[],
    expectsDelta: boolean
  ) {
    const timeline = selectToolInputTimeline(out);
    const toolCall = requireToolCall(out);
    expect(timeline.starts).toHaveLength(1);
    expect(timeline.ends).toHaveLength(1);
    if (expectsDelta) {
      expect(timeline.deltas.length).toBeGreaterThan(0);
    }
    expect(toolCall.toolCallId).toBe(timeline.starts[0]?.id);
    return { timeline, toolCall };
  }

  it("xml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const out = await runMorphStream(fixture.progressiveChunks);
    const { timeline, toolCall } = expectCompleteTimeline(out, true);

    expect(timeline.starts[0]?.id).toBe(timeline.ends[0]?.id);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(timeline.deltas.map((delta) => delta.delta).join("")).toBe(
      toolCall.input
    );
  });

  it("xml protocol emits progress deltas for union-typed object schemas", async () => {
    const unionWeatherTool: LanguageModelV4FunctionTool = {
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
    const out = await runMorphStream(fixture.progressiveChunks, [
      unionWeatherTool,
    ]);
    const { timeline, toolCall } = expectCompleteTimeline(out, true);

    expect(timeline.deltas.map((delta) => delta.delta).join("")).toBe(
      toolCall.input
    );
  });

  it("xml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const out = await runMorphStream(fixture.finishReconcileChunks);
    const { toolCall } = expectCompleteTimeline(out, false);

    expect(toolCall.input).toBe(fixture.expectedFinishInput);
  });

  const rejectedFinishCases = [
    {
      name: "xml finish reconciliation rejects unclosed payloads with trailing plain text",
      chunk: "<get_weather><location>Seoul</location> done",
    },
    {
      name: "xml finish reconciliation rejects unclosed payloads with tagless plain text body",
      chunk: "<get_weather>hello",
    },
  ];

  for (const testCase of rejectedFinishCases) {
    it(testCase.name, async () => {
      const out = await runMorphStream([testCase.chunk]);
      const timeline = selectToolInputTimeline(out);
      expect(out.some((part) => part.type === "tool-call")).toBe(false);
      expect(timeline.starts).toHaveLength(1);
      expect(timeline.ends).toHaveLength(1);
    });
  }

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
        } satisfies LanguageModelV4StreamPart,
        {
          type: "text-delta",
          id: "fixture",
          delta: "ul</location>\n<unit>celsius</unit>\n</get_weather>",
        },
      ]),
    });
    const parsedCalls = selectToolCalls(out).filter(
      ({ toolName }) => toolName === "get_weather"
    );
    const leakedText = collectTextDeltas(out);

    expect(parsedCalls).toHaveLength(1);
    expect(parsedCalls[0]?.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(leakedText).not.toContain("<get_weather>");
    expect(leakedText).not.toContain("</get_weather>");
  });

  it("xml malformed fixture does not leave dangling tool-input stream", async () => {
    const out = await runMorphStream(fixture.malformedChunks);
    const timeline = selectToolInputTimeline(out);
    expect(out.some((part) => part.type === "finish")).toBe(true);
    expect(timeline.starts.length).toBe(timeline.ends.length);
  });
});
