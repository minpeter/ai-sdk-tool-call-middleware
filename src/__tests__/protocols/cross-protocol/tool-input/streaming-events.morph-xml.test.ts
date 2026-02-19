import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

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

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function _assertCanonicalAiSdkEventOrder(parts: LanguageModelV3StreamPart[]) {
  const finishIndex = parts.findIndex((part) => part.type === "finish");
  assertCondition(finishIndex >= 0, "Missing finish event");
  assertCondition(
    finishIndex === parts.length - 1,
    "Finish event must be the final event"
  );

  const openTextSegments = new Map<string, number>();
  const openReasoningSegments = new Map<string, number>();
  const toolInputWindows = new Map<
    string,
    { startIndex: number; endIndex: number | null }
  >();

  parts.forEach((part, index) => {
    if (part.type === "text-start") {
      assertCondition(
        !openTextSegments.has(part.id),
        `Duplicate text-start for id '${part.id}'`
      );
      openTextSegments.set(part.id, index);
      return;
    }

    if (part.type === "text-delta") {
      assertCondition(
        openTextSegments.has(part.id),
        `text-delta without text-start for id '${part.id}'`
      );
      return;
    }

    if (part.type === "text-end") {
      const startIndex = openTextSegments.get(part.id);
      assertCondition(
        startIndex !== undefined,
        `text-end without text-start for id '${part.id}'`
      );
      assertCondition(
        (startIndex ?? index) < index,
        `text-end must occur after text-start for id '${part.id}'`
      );
      openTextSegments.delete(part.id);
      return;
    }

    if (part.type === "reasoning-start") {
      assertCondition(
        !openReasoningSegments.has(part.id),
        `Duplicate reasoning-start for id '${part.id}'`
      );
      openReasoningSegments.set(part.id, index);
      return;
    }

    if (part.type === "reasoning-delta") {
      assertCondition(
        openReasoningSegments.has(part.id),
        `reasoning-delta without reasoning-start for id '${part.id}'`
      );
      return;
    }

    if (part.type === "reasoning-end") {
      const startIndex = openReasoningSegments.get(part.id);
      assertCondition(
        startIndex !== undefined,
        `reasoning-end without reasoning-start for id '${part.id}'`
      );
      assertCondition(
        (startIndex ?? index) < index,
        `reasoning-end must occur after reasoning-start for id '${part.id}'`
      );
      openReasoningSegments.delete(part.id);
      return;
    }

    if (part.type === "tool-input-start") {
      assertCondition(
        !toolInputWindows.has(part.id),
        `Duplicate tool-input-start for id '${part.id}'`
      );
      toolInputWindows.set(part.id, { startIndex: index, endIndex: null });
      return;
    }

    if (part.type === "tool-input-delta") {
      const window = toolInputWindows.get(part.id);
      assertCondition(
        window !== undefined,
        `tool-input-delta without tool-input-start for id '${part.id}'`
      );
      assertCondition(
        (window?.startIndex ?? index) < index,
        `tool-input-delta must occur after tool-input-start for id '${part.id}'`
      );
      assertCondition(
        window?.endIndex == null,
        `tool-input-delta appears after tool-input-end for id '${part.id}'`
      );
      return;
    }

    if (part.type === "tool-input-end") {
      const window = toolInputWindows.get(part.id);
      assertCondition(
        window !== undefined,
        `tool-input-end without tool-input-start for id '${part.id}'`
      );
      assertCondition(
        (window?.startIndex ?? index) < index,
        `tool-input-end must occur after tool-input-start for id '${part.id}'`
      );
      assertCondition(
        window?.endIndex == null,
        `Duplicate tool-input-end for id '${part.id}'`
      );
      if (window) {
        window.endIndex = index;
      }
      return;
    }

    if (part.type === "tool-call") {
      const window = toolInputWindows.get(part.toolCallId);
      assertCondition(
        window !== undefined,
        `tool-call without tool-input-start for id '${part.toolCallId}'`
      );
      assertCondition(
        window?.endIndex != null,
        `tool-call before tool-input-end for id '${part.toolCallId}'`
      );
      assertCondition(
        (window?.endIndex ?? index) < index,
        `tool-call must occur after tool-input-end for id '${part.toolCallId}'`
      );
    }
  });

  assertCondition(
    openTextSegments.size === 0,
    `Unclosed text segments remain: ${openTextSegments.size}`
  );
  assertCondition(
    openReasoningSegments.size === 0,
    `Unclosed reasoning segments remain: ${openReasoningSegments.size}`
  );

  for (const window of toolInputWindows.values()) {
    assertCondition(
      window.endIndex != null,
      "Unclosed tool-input window found"
    );
  }
}

function _assertCoreAiSdkEventCoverage(parts: LanguageModelV3StreamPart[]) {
  const eventTypes = new Set(parts.map((part) => part.type));
  const requiredTypes: LanguageModelV3StreamPart["type"][] = [
    "text-start",
    "text-delta",
    "text-end",
    "tool-input-start",
    "tool-input-delta",
    "tool-input-end",
    "tool-call",
    "finish",
  ];

  for (const eventType of requiredTypes) {
    assertCondition(
      eventTypes.has(eventType),
      `Missing event type '${eventType}'`
    );
  }
}

function _assertHasEventTypes(
  parts: LanguageModelV3StreamPart[],
  requiredTypes: LanguageModelV3StreamPart["type"][]
) {
  const eventTypes = new Set(parts.map((part) => part.type));
  for (const eventType of requiredTypes) {
    assertCondition(
      eventTypes.has(eventType),
      `Missing event type '${eventType}'`
    );
  }
}

interface EventCheck {
  label: string;
  matches: (part: LanguageModelV3StreamPart) => boolean;
}

function _assertEventSequence(
  parts: LanguageModelV3StreamPart[],
  checks: EventCheck[]
) {
  let prevIndex = -1;
  for (const check of checks) {
    const index = parts.findIndex(
      (part, candidateIndex) =>
        candidateIndex > prevIndex && check.matches(part)
    );
    assertCondition(index >= 0, `Missing expected event: ${check.label}`);
    prevIndex = index;
  }
}

function _createOfficialPassthroughFixture(tag: string) {
  const reasoningId = `reasoning-${tag}`;
  const sourceUrlId = `source-url-${tag}`;
  const sourceDocumentId = `source-doc-${tag}`;
  const responseId = `response-${tag}`;
  const approvalId = `approval-${tag}`;
  const passthroughToolCallId = `passthrough-call-${tag}`;

  const parts: LanguageModelV3StreamPart[] = [
    {
      type: "stream-start",
      warnings: [],
    },
    {
      type: "reasoning-start",
      id: reasoningId,
    },
    {
      type: "reasoning-delta",
      id: reasoningId,
      delta: "thinking",
    },
    {
      type: "reasoning-end",
      id: reasoningId,
    },
    {
      type: "source",
      sourceType: "url",
      id: sourceUrlId,
      url: "https://example.com/rules",
      title: "Rules",
    },
    {
      type: "source",
      sourceType: "document",
      id: sourceDocumentId,
      mediaType: "application/pdf",
      title: "Spec",
      filename: "spec.pdf",
    },
    {
      type: "file",
      mediaType: "text/plain",
      data: "Y29tcGxpYW5jZQ==",
    },
    {
      type: "response-metadata",
      id: responseId,
      modelId: "compliance-model",
    },
    {
      type: "tool-approval-request",
      approvalId,
      toolCallId: passthroughToolCallId,
    },
    {
      type: "tool-input-start",
      id: passthroughToolCallId,
      toolName: "passthrough_marker",
    },
    {
      type: "tool-input-delta",
      id: passthroughToolCallId,
      delta: "{}",
    },
    {
      type: "tool-input-end",
      id: passthroughToolCallId,
    },
    {
      type: "tool-call",
      toolCallId: passthroughToolCallId,
      toolName: "passthrough_marker",
      input: "{}",
    },
    {
      type: "tool-result",
      toolCallId: passthroughToolCallId,
      toolName: "passthrough_marker",
      result: { ok: true },
    },
    {
      type: "raw",
      rawValue: { tag },
    },
    {
      type: "error",
      error: `error-${tag}`,
    },
  ];

  const checks: EventCheck[] = [
    {
      label: "stream-start",
      matches: (part) => part.type === "stream-start",
    },
    {
      label: "reasoning-start",
      matches: (part) =>
        part.type === "reasoning-start" && part.id === reasoningId,
    },
    {
      label: "reasoning-delta",
      matches: (part) =>
        part.type === "reasoning-delta" && part.id === reasoningId,
    },
    {
      label: "reasoning-end",
      matches: (part) =>
        part.type === "reasoning-end" && part.id === reasoningId,
    },
    {
      label: "source-url",
      matches: (part) =>
        part.type === "source" &&
        part.sourceType === "url" &&
        part.id === sourceUrlId,
    },
    {
      label: "source-document",
      matches: (part) =>
        part.type === "source" &&
        part.sourceType === "document" &&
        part.id === sourceDocumentId,
    },
    {
      label: "file",
      matches: (part) =>
        part.type === "file" && part.mediaType === "text/plain",
    },
    {
      label: "response-metadata",
      matches: (part) =>
        part.type === "response-metadata" && part.id === responseId,
    },
    {
      label: "tool-approval-request",
      matches: (part) =>
        part.type === "tool-approval-request" &&
        part.approvalId === approvalId &&
        part.toolCallId === passthroughToolCallId,
    },
    {
      label: "tool-input-start",
      matches: (part) =>
        part.type === "tool-input-start" && part.id === passthroughToolCallId,
    },
    {
      label: "tool-input-delta",
      matches: (part) =>
        part.type === "tool-input-delta" && part.id === passthroughToolCallId,
    },
    {
      label: "tool-input-end",
      matches: (part) =>
        part.type === "tool-input-end" && part.id === passthroughToolCallId,
    },
    {
      label: "tool-call",
      matches: (part) =>
        part.type === "tool-call" && part.toolCallId === passthroughToolCallId,
    },
    {
      label: "tool-result",
      matches: (part) =>
        part.type === "tool-result" &&
        part.toolCallId === passthroughToolCallId,
    },
    {
      label: "raw",
      matches: (part) => part.type === "raw",
    },
    {
      label: "error",
      matches: (part) => part.type === "error" && part.error === `error-${tag}`,
    },
  ];

  return { parts, checks };
}

const _allOfficialEventTypes: LanguageModelV3StreamPart["type"][] = [
  "stream-start",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-approval-request",
  "tool-call",
  "tool-result",
  "source",
  "file",
  "response-metadata",
  "raw",
  "error",
  "finish",
];

describe("cross-protocol tool-input streaming events: morph xml", () => {
  it("xml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = morphXmlProtocol();
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

  it("xml protocol emits progress deltas for union-typed object schemas", async () => {
    const fixture = toolInputStreamFixtures.xml;
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

    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: [unionWeatherTool],
    });
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
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(deltas.map((delta) => delta.delta)).toEqual(
      fixture.expectedProgressDeltas
    );
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("xml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = morphXmlProtocol();
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

  it("xml finish reconciliation rejects unclosed payloads with trailing plain text", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<get_weather><location>Seoul</location> done"]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("xml finish reconciliation rejects unclosed payloads with tagless plain text body", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<get_weather>hello"]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("xml protocol does not prematurely finalize tool call when non-text chunks are interleaved", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = morphXmlProtocol();
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
          } satisfies LanguageModelV3StreamPart,
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

  it("xml malformed fixture does not leave dangling tool-input stream", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = morphXmlProtocol();
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
});
