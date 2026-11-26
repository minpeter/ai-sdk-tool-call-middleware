import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import {
  decodeKExaone2HistoryKey,
  isKExaone2HistoryNumber,
} from "../../utils/codecs/k-exaone-2-lossless-json";
import { stringifyKExaone2NativeJson } from "../../utils/codecs/k-exaone-2-native-json";
import type { TCMProtocol } from "../protocol-interface";
import { qwen3CoderProtocol } from "../qwen3coder/protocol";
import { parseKExaoneToolCallInput } from "./tool-call-input";

/**
 * Format lineage (K-EXAONE-2.0 only):
 * - Call markup: `<tool_call>/<function=name>/<parameter=key>` (Qwen3-Coder family)
 * - Declarations: `<tool>{json}</tool>`; results: `<tool_result>`
 * - Not for earlier EXAONE / K-EXAONE-236B JSON-in-`<tool_call>` templates
 * - Template: LGAI-EXAONE/K-EXAONE-2.0-750B-A37B chat_template.jinja
 *
 * Composes `qwen3CoderProtocol()` as a black-box parser/streamer while
 * overriding only K-EXAONE-2.0-specific `formatToolCall`.
 * Reasoning stays provider-native (for Friendli, use `parse_reasoning: true`).
 */
function renderParameterValue(value: unknown): string {
  return typeof value === "string" ? value : stringifyKExaone2NativeJson(value);
}

function formatKExaone2ToolCall(toolCall: LanguageModelV4ToolCall): string {
  const input = parseKExaoneToolCallInput(toolCall.input);
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
  ...qwen3CoderProtocol(),
  formatToolCall(toolCall) {
    return formatKExaone2ToolCall(toolCall);
  },
});
