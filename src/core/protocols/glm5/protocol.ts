import { formatToolsWithPromptTemplate } from "../../utils/primitives/protocol-utils";
import type { TCMProtocol } from "../protocol-interface";
import {
  type Glm5ProtocolOptions,
  resolveGlm5ProtocolOptions,
} from "./call-parsing";
import { parseGlm5GeneratedText } from "./generated-text";
import { isDefinitelyPlainGlm5Text } from "./plain-text-fast-path";
import {
  extractGlm5ToolCallSegments,
  findGlm5ToolCallOpen,
} from "./segment-selection";
import { createGlm5StreamParser } from "./stream-parser";
import { formatGlm5ToolCall } from "./tool-call-formatting";

export function glm5Protocol(options?: Glm5ProtocolOptions): TCMProtocol {
  const protocolOptions = resolveGlm5ProtocolOptions(options);
  return {
    allowsFallbackRecovery(text) {
      return findGlm5ToolCallOpen(text, 0) === null;
    },

    createStreamParser(params) {
      return createGlm5StreamParser({ ...params, protocolOptions });
    },

    extractToolCallSegments({ text, tools }) {
      return extractGlm5ToolCallSegments({ protocolOptions, text, tools });
    },

    formatToolCall: formatGlm5ToolCall,

    formatTools({ tools, toolSystemPromptTemplate }) {
      return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
    },

    isDefinitelyPlainGeneratedText: isDefinitelyPlainGlm5Text,

    parseGeneratedText({ text, tools, options: parserOptions }) {
      return parseGlm5GeneratedText({
        parserOptions,
        protocolOptions,
        text,
        tools,
      });
    },
  };
}
