import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { extractSensitiveIncompleteToolCallDropSpans } from "../utils/generated-text-sensitive-candidates";
import { generateToolCallId } from "../utils/id";
import { addTextSegment } from "../utils/protocol-utils";
import { findNextToolCallSpan } from "./hermes-call-boundary";
import { processToolCallJson } from "./hermes-call-parsing";
import {
  recoverCompleteCallArrayBeforePartialEnd,
  recoverCompleteKnownCallBeforeNestedStart,
} from "./hermes-stream-lifecycle";
import type {
  ParserOptions,
  ProtocolToolCallResolver,
} from "./protocol-interface";

function dropSensitiveOrphanToolCall(options: {
  currentIndex: number;
  processedElements: LanguageModelV4Content[];
  spanStartIndex: number;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): number | null {
  const sensitiveDrop = extractSensitiveIncompleteToolCallDropSpans(
    options.text.slice(options.spanStartIndex),
    options.tools
  ).find((dropSpan) => dropSpan.startIndex === 0);
  if (!sensitiveDrop) {
    return null;
  }
  if (options.spanStartIndex > options.currentIndex) {
    addTextSegment(
      options.text.slice(options.currentIndex, options.spanStartIndex),
      options.processedElements
    );
  }
  return options.spanStartIndex + sensitiveDrop.endIndex;
}

function handleOrphanToolCallSpan(options: {
  currentIndex: number;
  nestedStartIndex?: number;
  processedElements: LanguageModelV4Content[];
  spanStartIndex: number;
  text: string;
  toolCallEnd: string;
  toolCallStart: string;
  tools: LanguageModelV4FunctionTool[];
  resolveToolCall: ProtocolToolCallResolver;
}): number {
  const dropEndIndex = dropSensitiveOrphanToolCall(options);
  if (dropEndIndex !== null) {
    return dropEndIndex;
  }

  const bodyStart = options.spanStartIndex + options.toolCallStart.length;
  if (options.nestedStartIndex !== undefined) {
    const recoveredCall = recoverCompleteKnownCallBeforeNestedStart(
      options.text.slice(bodyStart, options.nestedStartIndex),
      options.tools,
      options.resolveToolCall
    );
    if (recoveredCall) {
      if (options.spanStartIndex > options.currentIndex) {
        addTextSegment(
          options.text.slice(options.currentIndex, options.spanStartIndex),
          options.processedElements
        );
      }
      options.processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: recoveredCall.toolName,
        input: recoveredCall.input,
      });
      return options.nestedStartIndex;
    }
  }
  const arrayRecovery = recoverCompleteCallArrayBeforePartialEnd(
    options.text.slice(bodyStart),
    options.toolCallEnd,
    options.tools,
    options.resolveToolCall
  );
  const { recoveredCalls } = arrayRecovery;
  if (recoveredCalls && recoveredCalls.length > 0) {
    if (options.spanStartIndex > options.currentIndex) {
      addTextSegment(
        options.text.slice(options.currentIndex, options.spanStartIndex),
        options.processedElements
      );
    }
    for (const recoveredCall of recoveredCalls) {
      options.processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: recoveredCall.toolName,
        input: recoveredCall.input,
      });
    }
    return options.text.length;
  }

  const skipTo = options.spanStartIndex + options.toolCallStart.length;
  if (skipTo > options.currentIndex) {
    addTextSegment(
      options.text.slice(options.currentIndex, skipTo),
      options.processedElements
    );
  }
  return skipTo;
}

function findUnclosedJsonToolCallStart(
  text: string,
  span: NonNullable<ReturnType<typeof findNextToolCallSpan>>,
  toolCallStart: string,
  toolCallEnd: string,
  tools: LanguageModelV4FunctionTool[]
): number | null {
  if (span.found) {
    return null;
  }
  const { startIdx: startIndex } = span;
  const bodyStart = startIndex + toolCallStart.length;
  let jsonStart = bodyStart;
  while (jsonStart < text.length && text[jsonStart]?.trim().length === 0) {
    jsonStart += 1;
  }
  if (text[jsonStart] !== "{" || text.indexOf(toolCallEnd, bodyStart) !== -1) {
    return null;
  }
  if (
    extractSensitiveIncompleteToolCallDropSpans(
      text.slice(startIndex),
      tools
    ).some((dropSpan) => dropSpan.startIndex === 0)
  ) {
    return null;
  }
  return startIndex;
}

export function parseHermesGeneratedText({
  text,
  tools,
  options,
  toolCallStart,
  toolCallEnd,
  toolCallResolver,
}: {
  text: string;
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
  toolCallStart: string;
  toolCallEnd: string;
  toolCallResolver: ProtocolToolCallResolver;
}) {
  const processedElements: LanguageModelV4Content[] = [];
  let currentIndex = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const span = findNextToolCallSpan(
      text,
      searchFrom,
      toolCallStart,
      toolCallEnd
    );
    if (span === null) {
      break;
    }
    const unclosedStartIndex = findUnclosedJsonToolCallStart(
      text,
      span,
      toolCallStart,
      toolCallEnd,
      tools
    );
    if (unclosedStartIndex !== null) {
      if (unclosedStartIndex > currentIndex) {
        addTextSegment(
          text.slice(currentIndex, unclosedStartIndex),
          processedElements
        );
      }
      addTextSegment(text.slice(unclosedStartIndex), processedElements);
      currentIndex = text.length;
      break;
    }

    if (!span.found) {
      currentIndex = handleOrphanToolCallSpan({
        currentIndex,
        nestedStartIndex: span.nestedStartIndex,
        processedElements,
        spanStartIndex: span.startIdx,
        text,
        toolCallEnd,
        toolCallStart,
        tools,
        resolveToolCall: toolCallResolver,
      });
      searchFrom = currentIndex;
      continue;
    }

    const toolCallJson = text.slice(span.jsonStart, span.endIdx);
    const fullMatch = text.slice(
      span.startIdx,
      span.endIdx + toolCallEnd.length
    );

    if (span.startIdx > currentIndex) {
      addTextSegment(
        text.slice(currentIndex, span.startIdx),
        processedElements
      );
    }

    processToolCallJson(
      toolCallJson,
      fullMatch,
      processedElements,
      tools,
      options,
      toolCallResolver
    );
    currentIndex = span.endIdx + toolCallEnd.length;
    searchFrom = currentIndex;
  }

  if (currentIndex < text.length) {
    const remainingText = text.slice(currentIndex);
    addTextSegment(remainingText, processedElements);
  }

  return processedElements;
}
