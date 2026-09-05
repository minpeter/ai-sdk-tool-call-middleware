import {
  isJSONObject,
  type JSONObject,
  type JSONValue,
  type LanguageModelV4ToolCall,
} from "@ai-sdk/provider";

function parseToolCallInput(input: string): JSONObject | null {
  try {
    const parsed = JSON.parse(input);
    return isJSONObject(parsed) ? parsed : null;
  } catch {
    return {};
  }
}

function formatArgumentValue(value: JSONValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

export function formatGlm5ToolCall(toolCall: LanguageModelV4ToolCall): string {
  const parsed = parseToolCallInput(toolCall.input);
  let output = `<tool_call>${toolCall.toolName}`;
  if (parsed) {
    for (const [key, value] of Object.entries(parsed)) {
      output += `<arg_key>${key}</arg_key><arg_value>${formatArgumentValue(value)}</arg_value>`;
    }
  }
  return `${output}</tool_call>`;
}
