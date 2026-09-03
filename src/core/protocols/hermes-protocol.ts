import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { formatToolsWithPromptTemplate } from "../utils/protocol-utils";
import {
  findNextToolCallSpan,
  validateNonEmptyDelimiters,
} from "./hermes-call-boundary";
import { resolveToolCall } from "./hermes-call-parsing";
import { parseHermesGeneratedText } from "./hermes-generated-text";
import { createHermesStreamParser } from "./hermes-stream-parser";
import type {
  ProtocolToolCallResolver,
  TCMProtocol,
} from "./protocol-interface";

interface HermesProtocolOptions {
  resolveToolCall?: ProtocolToolCallResolver;
  toolCallEnd?: string;
  toolCallStart?: string;
}

export const hermesProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
  resolveToolCall: toolCallResolver = resolveToolCall,
}: HermesProtocolOptions = {}): TCMProtocol => ({
  ...validateNonEmptyDelimiters(toolCallStart, toolCallEnd),

  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV4FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV4FunctionTool[]) => string;
  }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall) {
    let args: unknown = {};
    if (toolCall.input != null) {
      try {
        args = JSON.parse(toolCall.input);
      } catch {
        args = toolCall.input;
      }
    }
    return `${toolCallStart}${JSON.stringify({
      name: toolCall.toolName,
      arguments: args,
    })}${toolCallEnd}`;
  },

  parseGeneratedText({ text, tools, options }) {
    return parseHermesGeneratedText({
      text,
      tools,
      options,
      toolCallStart,
      toolCallEnd,
      toolCallResolver,
    });
  },

  createStreamParser({ tools, options }) {
    return createHermesStreamParser({
      tools,
      options,
      toolCallStart,
      toolCallEnd,
      toolCallResolver,
    });
  },

  extractToolCallSegments({ text }) {
    const segments: string[] = [];
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
      if (!span.found) {
        searchFrom = span.startIdx + toolCallStart.length;
        continue;
      }
      segments.push(
        text.slice(span.startIdx, span.endIdx + toolCallEnd.length)
      );
      searchFrom = span.endIdx + toolCallEnd.length;
    }

    return segments;
  },
});
