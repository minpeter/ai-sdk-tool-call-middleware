import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import { stopFinishReason, zeroUsage } from "../../../test-helpers";

export function createTextDeltaStream(chunks: string[]) {
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
