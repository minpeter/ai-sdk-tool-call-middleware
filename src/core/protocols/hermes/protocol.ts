import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { formatToolsWithPromptTemplate } from "../../utils/primitives/protocol-utils";
import type {
  ParserOptions,
  ProtocolToolCallResolver,
  TCMProtocol,
} from "../protocol-interface";
import { validateNonEmptyDelimiters } from "./call-boundary";
import {
  extractNormalizedHermesArgumentsJson,
  normalizeHermesJsonControls,
  resolveToolCall,
} from "./call-parsing";
import {
  extractHermesToolCallSegments,
  parseHermesGeneratedText,
} from "./generated-text";
import { createHermesStreamParser } from "./stream-parser";

export interface HermesToolCallResolutionHelpers {
  extractNormalizedArgumentsJson: (toolCallJson: string) => string | null;
  normalizeJsonControls: (text: string) => string;
  resolveDefault: ProtocolToolCallResolver;
}

export interface HermesProtocolOptions {
  resolveToolCall?: ProtocolToolCallResolver;
  toolCallEnd?: string;
  toolCallStart?: string;
  wrapToolCallResolver?: (
    helpers: HermesToolCallResolutionHelpers
  ) => ProtocolToolCallResolver;
}

const DEFAULT_RESOLUTION_HELPERS: HermesToolCallResolutionHelpers = {
  extractNormalizedArgumentsJson: extractNormalizedHermesArgumentsJson,
  normalizeJsonControls: normalizeHermesJsonControls,
  resolveDefault: resolveToolCall,
};

export const hermesProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
  resolveToolCall: customResolver,
  wrapToolCallResolver,
}: HermesProtocolOptions = {}): TCMProtocol => {
  const toolCallResolver =
    wrapToolCallResolver?.(DEFAULT_RESOLUTION_HELPERS) ??
    customResolver ??
    resolveToolCall;

  return {
    ...validateNonEmptyDelimiters(toolCallStart, toolCallEnd),

    formatTools({
      tools,
      toolSystemPromptTemplate,
    }: {
      tools: LanguageModelV4FunctionTool[];
      toolSystemPromptTemplate: (
        tools: LanguageModelV4FunctionTool[]
      ) => string;
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

    parseGeneratedText({
      text,
      tools,
      options,
    }: {
      text: string;
      tools: LanguageModelV4FunctionTool[];
      options?: ParserOptions;
    }) {
      return parseHermesGeneratedText({
        text,
        tools,
        options,
        toolCallStart,
        toolCallEnd,
        resolveToolCall: toolCallResolver,
      });
    },

    createStreamParser({
      tools,
      options,
    }: {
      tools: LanguageModelV4FunctionTool[];
      options?: ParserOptions;
    }) {
      return createHermesStreamParser({
        tools,
        options,
        toolCallStart,
        toolCallEnd,
        resolveToolCall: toolCallResolver,
      });
    },

    extractToolCallSegments({ text }) {
      return extractHermesToolCallSegments({
        text,
        toolCallStart,
        toolCallEnd,
      });
    },
  };
};
