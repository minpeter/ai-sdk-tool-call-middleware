import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { jsonProtocol } from "../../core/protocols/json-protocol";
import { xmlProtocol } from "../../core/protocols/xml-protocol";
import { yamlProtocol } from "../../core/protocols/yaml-protocol";
import { toolInputStreamFixtures } from "../fixtures/tool-input-stream-fixtures";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

function createTextDeltaStream(chunks: string[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue({
          type: "text-delta",
          id: "fixture",
          delta: chunk,
        });
      }
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function createInterleavedStream(parts: LanguageModelV3StreamPart[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function extractToolInputTimeline(parts: LanguageModelV3StreamPart[]) {
  const starts = parts.filter(
    (part) => part.type === "tool-input-start"
  ) as Array<{
    type: "tool-input-start";
    id: string;
    toolName: string;
  }>;
  const deltas = parts.filter(
    (part) => part.type === "tool-input-delta"
  ) as Array<{
    type: "tool-input-delta";
    id: string;
    delta: string;
  }>;
  const ends = parts.filter((part) => part.type === "tool-input-end") as Array<{
    type: "tool-input-end";
    id: string;
  }>;
  return { starts, deltas, ends };
}

describe("tool-input streaming events", () => {
  it("json protocol emits tool-input-start/delta/end and reconciles id with tool-call", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.progressiveChunks),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].toolName).toBe("get_weather");
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol force-completes tool input at finish when closing tag is missing", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.finishReconcileChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Busan",
      unit: "celsius",
    });
  });

  it("xml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.progressiveChunks),
        transformer
      )
    );

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
    expect(deltas.map((delta) => delta.delta)).toEqual(
      fixture.expectedProgressDeltas
    );
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("xml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.finishReconcileChunks),
        transformer
      )
    );

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

  it("xml protocol does not prematurely finalize tool call when non-text chunks are interleaved", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createInterleavedStream([
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
          } as any,
          {
            type: "text-delta",
            id: "fixture",
            delta: "ul</location>\n<unit>celsius</unit>\n</get_weather>",
          },
        ]),
        transformer
      )
    );

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

  it("yaml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.progressiveChunks),
        transformer
      )
    );

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
    expect(deltas.map((delta) => delta.delta)).toEqual(
      fixture.expectedProgressDeltas
    );
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("yaml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.finishReconcileChunks),
        transformer
      )
    );

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

  it("yaml protocol does not prematurely finalize tool call when non-text chunks are interleaved", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createInterleavedStream([
          {
            type: "text-delta",
            id: "fixture",
            delta: "<get_weather>\nlocation: Seo",
          },
          {
            type: "tool-call",
            toolCallId: "passthrough-yaml",
            toolName: "passthrough_marker",
            input: "{}",
          } as any,
          {
            type: "text-delta",
            id: "fixture",
            delta: "ul\nunit: celsius\n</get_weather>",
          },
        ]),
        transformer
      )
    );

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

  it("json malformed fixture does not leave dangling tool-input stream", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.malformedChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts.length).toBe(ends.length);
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });

  it("xml malformed fixture does not leave dangling tool-input stream", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.malformedChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts.length).toBe(ends.length);
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });

  it("yaml malformed fixture stays non-leaking without dangling tool-input stream", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.malformedChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const text = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(starts.length).toBe(ends.length);
    expect(text).not.toContain("<get_weather>");
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });
});
