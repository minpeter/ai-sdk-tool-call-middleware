/**
 * Format lineage:
 * - `<function=name>` syntax: Llama 3.1 official prompt format
 *   (meta-llama/llama-models, models/llama3_1/prompt_format.md)
 * - `<parameter=key>` tags + "ONLY reply ... with NO suffix" instruction:
 *   OpenHands fn_call_converter (now: OpenHands/software-agent-sdk,
 *   openhands/sdk/llm/mixins/fn_call_converter.py)
 * - `<tool_call>` wrapper + first native chat-template adoption: Qwen3-Coder
 *   (org-wide Qwen standard since Qwen3.5)
 *
 * Named after Qwen3-Coder, matching vLLM's `qwen3_coder` tool parser name.
 * The wrapper-less OpenHands original shape is covered by `uiTarsXmlProtocol`.
 */
import {
  isJSONValue,
  type JSONValue,
  type LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import {
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
} from "../../rxml/utils/helpers";
import { formatToolsWithPromptTemplate } from "../utils/protocol-utils";
import type { TCMProtocol } from "./protocol-interface";
import { TOOL_CALL_BLOCK_RE } from "./qwen3coder-call-syntax";
import { parseQwen3CoderGeneratedText } from "./qwen3coder-generated-text";

import { createQwen3CoderStreamParser } from "./qwen3coder-stream-parser";

function parseToolCallInput(input: string | null | undefined): JSONValue {
  if (input == null) {
    return {};
  }
  try {
    const parsed = JSON.parse(input);
    return isJSONValue(parsed) ? parsed : input;
  } catch {
    return input;
  }
}

function toQwen3CoderToolParserParamText(value: JSONValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function appendQwen3CoderToolParserParameter(
  lines: string[],
  key: string,
  value: JSONValue | undefined
): void {
  const nameAttr = escapeXmlMinimalAttr(key, '"');
  const text = escapeXmlMinimalText(toQwen3CoderToolParserParamText(value));
  lines.push(`    <parameter="${nameAttr}">${text}</parameter>`);
}

function appendQwen3CoderToolParserArgs(
  lines: string[],
  args: JSONValue
): void {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          appendQwen3CoderToolParserParameter(lines, key, item);
        }
      } else {
        appendQwen3CoderToolParserParameter(lines, key, value);
      }
    }
    return;
  }

  if (args !== undefined && args !== null && args !== "") {
    appendQwen3CoderToolParserParameter(lines, "input", args);
  }
}

export const qwen3CoderProtocol = (): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall): string {
    const args = parseToolCallInput(toolCall.input);
    const lines: string[] = ["<tool_call>"];
    lines.push(
      `  <function="${escapeXmlMinimalAttr(toolCall.toolName, '"')}">`
    );
    appendQwen3CoderToolParserArgs(lines, args);
    lines.push("  </function>");
    lines.push("</tool_call>");
    return lines.join("\n");
  },

  parseGeneratedText(params) {
    return parseQwen3CoderGeneratedText(params);
  },

  extractToolCallSegments({ text }) {
    return Array.from(text.matchAll(TOOL_CALL_BLOCK_RE))
      .map((m) => m[0])
      .filter((s): s is string => Boolean(s));
  },

  createStreamParser(params) {
    return createQwen3CoderStreamParser(params);
  },
});

export const uiTarsXmlProtocol = qwen3CoderProtocol;

export const Qwen3CoderToolParser = qwen3CoderProtocol;
