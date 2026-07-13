import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import {
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
} from "../../rxml/utils/helpers";
import { formatToolsWithPromptTemplate } from "../utils/protocol-utils";
import type { TCMProtocol } from "./protocol-interface";
import { TOOL_CALL_BLOCK_RE } from "./qwen3coder-call-syntax";
import { parseQwen3CoderGeneratedText } from "./qwen3coder-generated-text";

import { createQwen3CoderStreamParser } from "./qwen3coder-stream-parser";

function parseToolCallInput(input: string | null | undefined): unknown {
  if (input == null) {
    return {};
  }
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function toQwen3CoderToolParserParamText(value: unknown): string {
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
  value: unknown
): void {
  const nameAttr = escapeXmlMinimalAttr(key, '"');
  const text = escapeXmlMinimalText(toQwen3CoderToolParserParamText(value));
  lines.push(`    <parameter="${nameAttr}">${text}</parameter>`);
}

function appendQwen3CoderToolParserArgs(lines: string[], args: unknown): void {
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
