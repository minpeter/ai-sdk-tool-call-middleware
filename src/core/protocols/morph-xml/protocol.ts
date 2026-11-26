import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { stringify } from "../../../rxml";
import { formatToolsWithPromptTemplate } from "../../utils/primitives/protocol-utils";
import type { TCMProtocol } from "../protocol-interface";
import {
  extractMorphXmlToolCallSegments,
  parseMorphXmlGeneratedText,
} from "./generated-text";
import { createMorphXmlStreamParser } from "./stream-parser";

export interface MorphXmlProtocolOptions {
  parseOptions?: {
    repair?: boolean;
    maxReparses?: number;
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
    noChildNodes?: string[];
    [key: string]: unknown;
  };
}

export const morphXmlProtocol = (
  protocolOptions?: MorphXmlProtocolOptions
): TCMProtocol => {
  const parseOptions = {
    repair: true,
    noChildNodes: [],
    ...(protocolOptions?.parseOptions ?? {}),
  };

  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
    },

    formatToolCall(toolCall: LanguageModelV4ToolCall): string {
      let args: unknown = {};
      if (toolCall.input != null) {
        try {
          args = JSON.parse(toolCall.input);
        } catch {
          args = toolCall.input;
        }
      }
      return stringify(toolCall.toolName, args, {
        suppressEmptyNode: false,
        format: true,
        minimalEscaping: true,
      });
    },

    parseGeneratedText({ text, tools, options }) {
      return parseMorphXmlGeneratedText({
        text,
        tools,
        options,
        parseOptions,
      });
    },

    createStreamParser({ tools, options }) {
      return createMorphXmlStreamParser({
        tools,
        options,
        parseOptions,
      });
    },

    extractToolCallSegments({ text, tools }) {
      return extractMorphXmlToolCallSegments({ text, tools });
    },
  };
};
