import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import {
  safeToolCallMetadataText,
  safeToolCallMetadataValue,
} from "../primitives/protocol-utils";
import { getDebugLevel, logParsedSummary } from "./debug";

export interface ToolCallMiddlewareDebugSummary {
  originalText?: string;
  toolCalls?: string; // JSON string of array of { toolName, input }
}

export function recordForcedToolChoiceDebugSummary(options: {
  debugSummary: ToolCallMiddlewareDebugSummary | undefined;
  originText: string;
  toolCall: LanguageModelV4ToolCall;
}): void {
  const { debugSummary, originText, toolCall } = options;
  if (debugSummary) {
    debugSummary.originalText = originText;
    try {
      debugSummary.toolCalls = JSON.stringify([
        {
          toolName: toolCall.toolName,
          input: safeToolCallMetadataValue(toolCall.input),
        },
      ]);
    } catch {
      // ignore JSON failure
    }
  } else if (getDebugLevel() === "parse") {
    logParsedSummary({ toolCalls: [toolCall], originalText: originText });
  }
}

export function recordParsedDebugSummary(options: {
  allText: string;
  debugSummary: ToolCallMiddlewareDebugSummary | undefined;
  extractToolCallSegments?: (params: {
    text: string;
    tools: LanguageModelV4FunctionTool[];
  }) => string[];
  toolCalls: LanguageModelV4ToolCall[];
  tools: LanguageModelV4FunctionTool[];
}): void {
  const {
    allText,
    debugSummary: dbg,
    extractToolCallSegments,
    toolCalls,
    tools,
  } = options;
  const debugLevel = getDebugLevel();
  if (!dbg && debugLevel !== "parse") {
    return;
  }

  const segments = extractToolCallSegments
    ? extractToolCallSegments({ text: allText, tools })
    : [];
  const originalText = safeToolCallMetadataText(segments.join("\n\n")) ?? "";

  if (dbg) {
    dbg.originalText = originalText;
    try {
      dbg.toolCalls = JSON.stringify(
        toolCalls.map((tc) => ({
          toolName: tc.toolName,
          input: safeToolCallMetadataValue(tc.input),
        }))
      );
    } catch {
      // ignore JSON failure
    }
  } else if (debugLevel === "parse") {
    logParsedSummary({ toolCalls, originalText });
  }
}
