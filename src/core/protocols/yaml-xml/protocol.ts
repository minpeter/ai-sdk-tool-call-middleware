import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import YAML from "yaml";
import { formatToolsWithPromptTemplate } from "../../utils/primitives/protocol-utils";
import type { TCMProtocol } from "../protocol-interface";
import {
  extractYamlXmlToolCallSegments,
  parseYamlXmlGeneratedText,
} from "./generated-text";
import { createYamlXmlStreamParser } from "./stream-parser";

export interface YamlXmlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

export const yamlXmlProtocol = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future extensibility
  _protocolOptions?: YamlXmlProtocolOptions
): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall): string {
    let args: Record<string, unknown> = {};
    if (toolCall.input != null) {
      try {
        args = JSON.parse(toolCall.input) as Record<string, unknown>;
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
    return extractYamlXmlToolCallSegments({ text, tools });
  },
});
