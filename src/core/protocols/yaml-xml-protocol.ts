import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import YAML from "yaml";
import {
  extractToolNames,
  formatToolsWithPromptTemplate,
} from "../utils/protocol-utils";
import type { TCMCoreProtocol } from "./protocol-interface";
import { parseYamlXmlGeneratedText } from "./yaml-xml-generated-text";
import { findToolCalls } from "./yaml-xml-parsing";
import { createYamlXmlStreamParser } from "./yaml-xml-stream-parser";

export interface YamlXmlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

export const yamlXmlProtocol = (
  _protocolOptions?: YamlXmlProtocolOptions
): TCMCoreProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall): string {
    let args: unknown = {};
    if (toolCall.input != null) {
      try {
        args = JSON.parse(toolCall.input);
      } catch {
        args = { value: toolCall.input };
      }
    }
    const yamlContent = YAML.stringify(args);
    return `<${toolCall.toolName}>\n${yamlContent}</${toolCall.toolName}>`;
  },

  parseGeneratedText({ text, tools, options }) {
    return parseYamlXmlGeneratedText({ text, tools, options });
  },

  createStreamParser({ tools, options }) {
    return createYamlXmlStreamParser({ tools, options });
  },

  extractToolCallSegments({ text, tools }) {
    const toolNames = extractToolNames(tools);
    if (toolNames.length === 0) {
      return [];
    }
    return findToolCalls(text, toolNames).map(
      (toolCall) =>
        `<${toolCall.toolName}>${toolCall.content}</${toolCall.toolName}>`
    );
  },
});
