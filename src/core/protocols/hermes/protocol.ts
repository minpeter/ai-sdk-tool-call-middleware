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
  readonly extractNormalizedArgumentsJson: (
    toolCallJson: string
  ) => string | null;
  readonly normalizeJsonControls: (text: string) => string;
  readonly resolveDefault: ProtocolToolCallResolver;
}

export interface HermesProtocolOptions {
  /**
   * Custom resolver for `<tool_call>` JSON payloads. When combined with
   * `wrapToolCallResolver`, this resolver is exposed as `helpers.resolveDefault`
   * so wrappers can compose around it.
   */
  resolveToolCall?: ProtocolToolCallResolver;
  toolCallEnd?: string;
  toolCallStart?: string;
  /**
   * Factory that wraps the Hermes tool-call resolver with read-only helper
   * primitives (`resolveDefault` delegates to `resolveToolCall` if provided,
   * otherwise to the built-in Hermes resolver).
   */
  wrapToolCallResolver?: (
    helpers: HermesToolCallResolutionHelpers
  ) => ProtocolToolCallResolver;
}

export const hermesProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
  resolveToolCall: customResolver,
  wrapToolCallResolver,
}: HermesProtocolOptions = {}): TCMProtocol => {
  validateNonEmptyDelimiters(toolCallStart, toolCallEnd);

  const baseResolver = customResolver ?? resolveToolCall;
  const resolutionHelpers: HermesToolCallResolutionHelpers = Object.freeze({
    extractNormalizedArgumentsJson: extractNormalizedHermesArgumentsJson,
    normalizeJsonControls: normalizeHermesJsonControls,
    resolveDefault: baseResolver,
  });
  const toolCallResolver =
    wrapToolCallResolver?.(resolutionHelpers) ?? baseResolver;

  return {
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
