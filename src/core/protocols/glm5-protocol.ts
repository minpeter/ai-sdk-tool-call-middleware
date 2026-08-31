import { formatToolsWithPromptTemplate } from "../utils/protocol-utils";
import {
  type Glm5ProtocolOptions,
  resolveGlm5ProtocolOptions,
} from "./glm5-call-parsing";
import {
  isDefinitelyPlainGlm5Text,
  registerGlm5FastPaths,
} from "./glm5-fast-path-registry";
import { parseGlm5GeneratedText } from "./glm5-generated-text";
import {
  extractGlm5ToolCallSegments,
  findGlm5ToolCallOpen,
} from "./glm5-segment-selection";
import { createGlm5StreamParser } from "./glm5-stream-parser";
import { formatGlm5ToolCall } from "./glm5-tool-call-formatting";
import type { TCMProtocol } from "./protocol-interface";

export function glm5Protocol(options?: Glm5ProtocolOptions): TCMProtocol {
  const protocolOptions = resolveGlm5ProtocolOptions(options);
  const protocol: TCMProtocol = {
    allowsGeneratedTextJsonRecovery(text) {
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

    parseGeneratedText({ text, tools, options: parserOptions }) {
      return parseGlm5GeneratedText({
        parserOptions,
        protocolOptions,
        text,
        tools,
      });
    },
  };
  registerGlm5FastPaths(protocol.parseGeneratedText, {
    isDefinitelyPlainGeneratedText: isDefinitelyPlainGlm5Text,
  });
  return protocol;
}
