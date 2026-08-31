import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";

function parseToolCallInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed;
  } catch {
    return {};
  }
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

export function formatGlm5ToolCall(toolCall: LanguageModelV4ToolCall): string {
  const parsed = parseToolCallInput(toolCall.input);
  let output = `<tool_call>${toolCall.toolName}`;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      output += `<arg_key>${key}</arg_key><arg_value>${formatArgumentValue(value)}</arg_value>`;
    }
  }
  return `${output}</tool_call>`;
}
