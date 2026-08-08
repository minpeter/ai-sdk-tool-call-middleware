import type {
  LanguageModelV4Content,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
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
 * Parse/stream reuses qwen3coder; formatToolCall + non-stream `<think>` are local.
 */
const COMPLETE_THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>/gi;

function parseToolCallInput(input: string | null | undefined): unknown {
  if (input == null) {
    return {};
  }

  try {
    return JSON.parse(input) as unknown;
  } catch {
    return {};
  }
}

function renderParameterValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? "null";
}

function formatKExaone2ToolCall(toolCall: LanguageModelV4ToolCall): string {
  const input = parseToolCallInput(toolCall.input);
  const parameters =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Object.entries(input)
          .map(
            ([name, value]) =>
              `<parameter=${name}>\n${renderParameterValue(value)}\n</parameter>`
          )
          .join("\n")
      : "";
  const parameterSection = parameters.length > 0 ? `\n${parameters}` : "";

  return `<tool_call>\n<function=${toolCall.toolName}>${parameterSection}\n</function>\n</tool_call>`;
}

function parseKExaone2GeneratedText(
  params: Parameters<typeof parseQwen3CoderGeneratedText>[0]
): LanguageModelV4Content[] {
  const matches = Array.from(params.text.matchAll(COMPLETE_THINK_BLOCK_RE));
  if (matches.length === 0) {
    return parseQwen3CoderGeneratedText(params);
  }

  const content: LanguageModelV4Content[] = [];
  let index = 0;
  for (const match of matches) {
    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }

    const before = params.text.slice(index, start);
    if (before.length > 0) {
      content.push(
        ...parseQwen3CoderGeneratedText({ ...params, text: before })
      );
    }
    content.push({ type: "reasoning", text: match[1] ?? "" });
    index = start + match[0].length;
  }

  const after = params.text.slice(index);
  if (after.length > 0) {
    content.push(...parseQwen3CoderGeneratedText({ ...params, text: after }));
  }
  return content;
}

export const kExaone2Protocol = (): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall) {
    return formatKExaone2ToolCall(toolCall);
  },

  parseGeneratedText(params) {
    return parseKExaone2GeneratedText(params);
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
