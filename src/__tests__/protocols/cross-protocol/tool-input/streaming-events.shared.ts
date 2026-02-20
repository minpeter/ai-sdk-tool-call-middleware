import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import type {
  ParserOptions,
  TCMProtocol,
} from "../../../../core/protocols/protocol-interface";

import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

export function createTextDeltaStream(chunks: string[], id = "fixture") {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue({
          type: "text-delta",
          id,
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

export function createInterleavedStream(parts: LanguageModelV3StreamPart[]) {
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

export function runProtocolStreamParser(options: {
  protocol: Pick<TCMProtocol, "createStreamParser">;
  tools: LanguageModelV3FunctionTool[];
  stream: ReadableStream<LanguageModelV3StreamPart>;
  parserOptions?: ParserOptions;
}) {
  const transformer = options.protocol.createStreamParser({
    tools: options.tools,
    options: options.parserOptions,
  });
  return convertReadableStreamToArray(
    pipeWithTransformer(options.stream, transformer)
  );
}

export function runProtocolTextDeltaStream(options: {
  protocol: Pick<TCMProtocol, "createStreamParser">;
  tools: LanguageModelV3FunctionTool[];
  chunks: string[];
  id?: string;
  options?: ParserOptions;
}) {
  return runProtocolStreamParser({
    protocol: options.protocol,
    tools: options.tools,
    parserOptions: options.options,
    stream: createTextDeltaStream(options.chunks, options.id),
  });
}

export function extractToolInputTimeline(parts: LanguageModelV3StreamPart[]) {
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

export function extractToolInputDeltas(
  parts: LanguageModelV3StreamPart[]
): string[] {
  return parts
    .filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    )
    .map((part) => part.delta);
}

export function extractTextDeltas(parts: LanguageModelV3StreamPart[]): string {
  return parts
    .filter(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
        part.type === "text-delta"
    )
    .map((part) => part.delta)
    .join("");
}

export function findToolCall(
  parts: LanguageModelV3StreamPart[]
): Extract<LanguageModelV3StreamPart, { type: "tool-call" }> {
  const toolCall = parts.find(
    (part): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
      part.type === "tool-call"
  );
  if (!toolCall) {
    throw new Error("Expected tool-call part");
  }
  return toolCall;
}

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertCanonicalAiSdkEventOrder(
  parts: LanguageModelV3StreamPart[]
) {
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

export function assertCoreAiSdkEventCoverage(
  parts: LanguageModelV3StreamPart[]
) {
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

export function assertHasEventTypes(
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

export interface EventCheck {
  label: string;
  matches: (part: LanguageModelV3StreamPart) => boolean;
}

export function assertEventSequence(
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

export function createOfficialPassthroughFixture(tag: string): {
  parts: LanguageModelV3StreamPart[];
  checks: EventCheck[];
} {
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

export const allOfficialEventTypes: LanguageModelV3StreamPart["type"][] = [
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
