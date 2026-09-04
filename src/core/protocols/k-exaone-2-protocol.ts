import {
  isJSONValue,
  type JSONValue,
  type LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import {
  decodeKExaone2HistoryKey,
  isKExaone2HistoryNumber,
} from "../prompts/k-exaone-2-lossless-json";
import { stringifyKExaone2NativeJson } from "../prompts/k-exaone-2-native-json";
import { formatToolsWithPromptTemplate } from "../utils/protocol-utils";
import { parseKExaoneToolCallInput } from "./k-exaone-tool-call-input";
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
function isKExaone2Value(value: JSONValue | object): value is JSONValue {
  if (isKExaone2HistoryNumber(value) || isJSONValue(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isKExaone2Value);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).every(
    (entry) => entry === undefined || isKExaone2Value(entry)
  );
}

function renderParameterValue(value: JSONValue | object): string {
  if (typeof value === "string") {
    return value;
  }
  return stringifyKExaone2NativeJson(isKExaone2Value(value) ? value : null);
}

function formatKExaone2ToolCall(toolCall: LanguageModelV4ToolCall): string {
  const parsedInput = parseKExaoneToolCallInput(toolCall.input);
  const input =
    parsedInput === null ||
    typeof parsedInput === "string" ||
    typeof parsedInput === "number" ||
    typeof parsedInput === "boolean" ||
    typeof parsedInput === "object"
      ? parsedInput
      : null;
  const entries: [string, JSONValue | object][] =
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
