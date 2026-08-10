import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import {
  decodeKExaone2HistoryKey,
  isKExaone2HistoryNumber,
  parseKExaone2LosslessJson,
} from "../prompts/k-exaone-2-lossless-json";
import { stringifyKExaone2NativeJson } from "../prompts/k-exaone-2-native-json";
import { KExaone2SerializationError } from "../prompts/k-exaone-2-serialization-error";
import { formatToolsWithPromptTemplate } from "../utils/protocol-utils";
import type { TCMProtocol } from "./protocol-interface";
import { TOOL_CALL_BLOCK_RE } from "./qwen3coder-call-syntax";
import { parseQwen3CoderGeneratedText } from "./qwen3coder-generated-text";
import { createQwen3CoderStreamParser } from "./qwen3coder-stream-parser";

/**
 * Format lineage (K-EXAONE-2.0 only):
 * - Call markup: `<tool_call>/<function=name>/<parameter=key>` (Qwen3-Coder family)
 * - Declarations: `<tool>{json}</tool>`; results: `<tool_result>`
 * - Not for earlier EXAONE / K-EXAONE-236B JSON-in-`<tool_call>` templates
 * - Template: LGAI-EXAONE/K-EXAONE-2.0-750B-A37B chat_template.jinja
 *
 * Parse/stream reuses qwen3coder; formatToolCall is K-EXAONE-2.0-specific.
 * Reasoning stays provider-native (for Friendli, use `parse_reasoning: true`).
 */
function parseToolCallInput(input: string | null | undefined): unknown {
  if (input == null) {
    return {};
  }

  try {
    return parseKExaone2LosslessJson(input);
  } catch (error) {
    if (error instanceof KExaone2SerializationError) {
      throw error;
    }
    return input;
  }
}

function renderParameterValue(value: unknown): string {
  return typeof value === "string" ? value : stringifyKExaone2NativeJson(value);
}

function formatKExaone2ToolCall(toolCall: LanguageModelV4ToolCall): string {
  const input = parseToolCallInput(toolCall.input);
  const entries: [string, unknown][] =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    !isKExaone2HistoryNumber(input)
      ? Object.entries(input).map(([name, value]) => [
          decodeKExaone2HistoryKey(name),
          value,
        ])
      : [["input", input]];
  const parameters = entries
    .map(
      ([name, value]) =>
        `<parameter=${name}>\n${renderParameterValue(value)}\n</parameter>`
    )
    .join("\n");
  const parameterSection = parameters.length > 0 ? `\n${parameters}` : "";

  return `<tool_call>\n<function=${toolCall.toolName}>${parameterSection}\n</function>\n</tool_call>`;
}

export const kExaone2Protocol = (): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall) {
    return formatKExaone2ToolCall(toolCall);
  },

  parseGeneratedText(params) {
    return parseQwen3CoderGeneratedText(params);
  },

  extractToolCallSegments({ text }) {
    return Array.from(text.matchAll(TOOL_CALL_BLOCK_RE))
      .map((match) => match[0])
      .filter((segment): segment is string => Boolean(segment));
  },

  createStreamParser(params) {
    return createQwen3CoderStreamParser(params);
  },
});

export const KExaone2ToolParser = kExaone2Protocol;
